const prisma = require("../config/db");
const logActivity = require("../utils/activityLogger");
const { makeOrderNoTx } = require("../utils/numbering");
const { requireSingleFactory } = require("../utils/factoryScope");
const { orderVisibilityWhere } = require("../utils/factoryVisibility");
const { ensureInvoiceForOrderTx, syncInvoiceFromOrderTx } = require("../services/orderInvoiceService");
const { getPagination, buildPaginationMeta } = require("../utils/pagination");
const { getBalanceTx, createMovementTx } = require("../services/inventoryLedgerService");

function parseDateOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toNumber(v) {
  const n = typeof v === "string" ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

// NOTE: This uses scalar FK filters. If your InventoryMovement model also moved to "relations-only",
// then this function must be updated too (tell me if you see "Unknown argument company_id" in aggregate filters).
async function getStockTx(tx, company_id, factory_id, product_id) {
  return getBalanceTx(tx, company_id, factory_id, product_id);
}

function calcLineTotal(qty, price, discount) {
  const d = discount ? Number(discount) : 0;
  return qty * price - d;
}

function sumCharges(charges = []) {
  return charges.reduce((acc, c) => acc + Number(c.amount || 0), 0);
}

const ORDER_STATUS_VALUES = new Set([
  "DRAFT",
  "CONFIRMED",
  "PROCESSING",
  "DISPATCHED",
  "COMPLETED",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
  "CLOSED"
]);

const DISPATCH_TRIGGER_STATUSES = new Set(["DISPATCHED", "COMPLETED", "SHIPPED", "DELIVERED"]);

function normalizeOrderStatusInput(value) {
  const raw = (value || "").toString().trim().toUpperCase();
  if (!raw) return null;

  const aliasMap = {
    DISPATCH: "DISPATCHED",
    COMPLETE: "COMPLETED"
  };

  const normalized = aliasMap[raw] || raw;
  return ORDER_STATUS_VALUES.has(normalized) ? normalized : null;
}

function isDispatchTriggerStatus(status) {
  return DISPATCH_TRIGGER_STATUSES.has(String(status || "").toUpperCase());
}

function hasCommittedInventory(order) {
  return isDispatchTriggerStatus(order?.status) || Boolean(order?.fulfillments?.some((f) => f.is_active !== false));
}

function aggregateOrderQtyByProduct(items = []) {
  const map = new Map();
  for (const item of items) {
    const productId = String(item.product_id);
    map.set(productId, (map.get(productId) || 0) + Number(item.quantity || 0));
  }
  return map;
}

function buildDispatchAllocationRows(order, payload, fallbackFactoryId) {
  const orderedQtyByProduct = aggregateOrderQtyByProduct(order.items || []);
  const orderProductIds = [...orderedQtyByProduct.keys()];
  const singleProductId = orderProductIds.length === 1 ? orderProductIds[0] : null;

  const normalizeProductId = (value) => {
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
    return singleProductId;
  };

  let sourceRows = [];
  const topLevelRows = Array.isArray(payload?.allocations)
    ? payload.allocations
    : (Array.isArray(payload?.fulfillments) ? payload.fulfillments : null);

  const hasItemLevelAllocations = Array.isArray(payload?.items)
    && payload.items.some((it) => Array.isArray(it?.allocations) || Array.isArray(it?.fulfillments));

  if (topLevelRows && topLevelRows.length) {
    sourceRows = topLevelRows.map((row) => ({
      product_id: normalizeProductId(row.product_id),
      factory_id: row.factory_id,
      quantity: row.quantity
    }));
  } else if (hasItemLevelAllocations) {
    for (const item of payload.items) {
      const rows = Array.isArray(item?.allocations) ? item.allocations : (Array.isArray(item?.fulfillments) ? item.fulfillments : []);
      const productId = normalizeProductId(item?.product_id);
      for (const row of rows) {
        sourceRows.push({
          product_id: normalizeProductId(row.product_id) || productId,
          factory_id: row.factory_id,
          quantity: row.quantity
        });
      }
    }
  } else if (Array.isArray(order.fulfillments) && order.fulfillments.length) {
    sourceRows = order.fulfillments.map((row) => ({
      product_id: row.product_id,
      factory_id: row.factory_id,
      quantity: row.quantity
    }));
  } else {
    sourceRows = orderProductIds.map((product_id) => ({
      product_id,
      factory_id: fallbackFactoryId,
      quantity: orderedQtyByProduct.get(product_id)
    }));
  }

  const aggregated = new Map();
  for (const row of sourceRows) {
    const product_id = normalizeProductId(row.product_id);
    const factory_id = row.factory_id ? String(row.factory_id).trim() : "";
    const quantity = Number(row.quantity);

    if (!product_id) {
      const err = new Error("DISPATCH_ALLOCATIONS_INVALID");
      err.statusCode = 400;
      err.meta = { reason: "product_id is required for each allocation when the order has multiple products" };
      throw err;
    }
    if (!orderedQtyByProduct.has(product_id)) {
      const err = new Error("DISPATCH_ALLOCATIONS_INVALID");
      err.statusCode = 400;
      err.meta = { reason: "allocation contains a product that is not part of the order", product_id };
      throw err;
    }
    if (!factory_id) {
      const err = new Error("DISPATCH_ALLOCATIONS_INVALID");
      err.statusCode = 400;
      err.meta = { reason: "factory_id is required for each dispatch allocation", product_id };
      throw err;
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      const err = new Error("DISPATCH_ALLOCATIONS_INVALID");
      err.statusCode = 400;
      err.meta = { reason: "allocation quantity must be > 0", product_id, factory_id, quantity: row.quantity };
      throw err;
    }

    const key = `${factory_id}|${product_id}`;
    aggregated.set(key, {
      product_id,
      factory_id,
      quantity: (aggregated.get(key)?.quantity || 0) + quantity
    });
  }

  const allocationRows = [...aggregated.values()];
  const allocatedQtyByProduct = new Map();
  for (const row of allocationRows) {
    allocatedQtyByProduct.set(row.product_id, (allocatedQtyByProduct.get(row.product_id) || 0) + Number(row.quantity));
  }

  const missingProducts = orderProductIds.filter((product_id) => !allocatedQtyByProduct.has(product_id));
  if (missingProducts.length) {
    const err = new Error("DISPATCH_ALLOCATIONS_INVALID");
    err.statusCode = 400;
    err.meta = { reason: "dispatch allocations are missing one or more ordered products", missing_product_ids: missingProducts };
    throw err;
  }

  for (const product_id of orderProductIds) {
    const orderedQty = Number(orderedQtyByProduct.get(product_id) || 0);
    const allocatedQty = Number(allocatedQtyByProduct.get(product_id) || 0);
    if (Math.abs(orderedQty - allocatedQty) > 1e-9) {
      const err = new Error("DISPATCH_ALLOCATIONS_INVALID");
      err.statusCode = 400;
      err.meta = {
        reason: "dispatch allocation quantity must match ordered quantity",
        product_id,
        ordered_quantity: orderedQty,
        allocated_quantity: allocatedQty
      };
      throw err;
    }
  }

  return allocationRows;
}

function buildInsufficientStockMessage(shortages = []) {
  const factories = [...new Set(shortages.map((row) => row.factory_name || row.factory_id))];
  if (!factories.length) return "Insufficient stock for one or more items";
  if (factories.length === 1) return `Insufficient stock in ${factories[0]}`;
  return `Insufficient stock in ${factories.join(", ")}`;
}

function getRequestedFactoryFilter(req) {
  const q = (req.query.factory_id || "").toString().trim();
  const h = (req.headers["x-factory-id"] || "").toString().trim();

  const requested = q || h;
  if (!requested || requested.toLowerCase() === "all") return null;

  return requested;
}

async function validateDispatchAllocationsTx(tx, { company_id, user, order, allocationRows }) {
  const factoryIds = [...new Set(allocationRows.map((row) => row.factory_id))];
  const productIds = [...new Set(allocationRows.map((row) => row.product_id))];

  const [factories, products] = await Promise.all([
    tx.factory.findMany({
      where: { company_id, id: { in: factoryIds }, is_active: true },
      select: { id: true, name: true }
    }),
    tx.product.findMany({
      where: { company_id, id: { in: productIds }, is_active: true },
      select: { id: true, name: true }
    })
  ]);

  if (factories.length !== factoryIds.length) {
    const found = new Set(factories.map((f) => f.id));
    const missing = factoryIds.filter((id) => !found.has(id));
    const err = new Error("FACTORY_NOT_FOUND");
    err.statusCode = 404;
    err.meta = { missing_factory_ids: missing };
    throw err;
  }

  if (products.length !== productIds.length) {
    const found = new Set(products.map((p) => p.id));
    const missing = productIds.filter((id) => !found.has(id));
    const err = new Error("PRODUCT_NOT_FOUND");
    err.statusCode = 404;
    err.meta = { missing_product_ids: missing };
    throw err;
  }

  if (!user.is_admin) {
    const access = await tx.userFactoryMap.findMany({
      where: { company_id, user_id: user.id, factory_id: { in: factoryIds } },
      select: { factory_id: true }
    });
    if (access.length !== factoryIds.length) {
      const allowed = new Set(access.map((row) => row.factory_id));
      const missing = factoryIds.filter((id) => !allowed.has(id));
      const err = new Error("UNAUTHORIZED_FACTORY_ACCESS");
      err.statusCode = 403;
      err.meta = { missing_factory_ids: missing };
      throw err;
    }
  }

  const factoryNameById = new Map(factories.map((row) => [row.id, row.name]));
  const productNameById = new Map(products.map((row) => [row.id, row.name]));

  const shortages = [];
  for (const row of allocationRows) {
    const available = await getStockTx(tx, company_id, row.factory_id, row.product_id);
    const required = Number(row.quantity || 0);
    if (available < required) {
      shortages.push({
        factory_id: row.factory_id,
        factory_name: factoryNameById.get(row.factory_id) || row.factory_id,
        product_id: row.product_id,
        product_name: productNameById.get(row.product_id) || row.product_id,
        available_stock: available,
        required_stock: required,
        short_by: required - available
      });
    }
  }

  if (shortages.length) {
    const err = new Error("INSUFFICIENT_STOCK");
    err.statusCode = 400;
    err.meta = {
      shortages,
      shortage_factories: [...new Set(shortages.map((row) => row.factory_id))],
      shortage_factory_names: [...new Set(shortages.map((row) => row.factory_name))],
      details: buildInsufficientStockMessage(shortages)
    };
    throw err;
  }

  return { factoryNameById, productNameById };
}

function buildRequestedFactoryOrderFilter(requestedFactoryId) {
  if (!requestedFactoryId) return null;

  return {
    OR: [
      // Non-dispatched / pre-commit orders should filter only by primary factory
      {
        status: { in: ["DRAFT", "CONFIRMED", "PROCESSING"] },
        factory_id: requestedFactoryId
      },

      // Dispatched / committed orders should prefer fulfillment-based matching
      {
        status: { in: ["DISPATCHED", "COMPLETED", "SHIPPED", "DELIVERED", "CANCELLED", "CLOSED"] },
        OR: [
          { fulfillments: { some: { factory_id: requestedFactoryId, is_active: true } } },

          // fallback for older records with no fulfillments
          {
            AND: [
              { fulfillments: { none: { is_active: true } } },
              { factory_id: requestedFactoryId }
            ]
          }
        ]
      }
    ]
  };
}

exports.getOrders = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const fw = orderVisibilityWhere(req);
    const requestedFactoryId = getRequestedFactoryFilter(req);

    const client_id = (req.query.client_id || "").toString().trim();
    const sales_company_id = (req.query.sales_company_id || "").toString().trim();
    const rawStatus = (req.query.status || "").toString().trim();
    const status = rawStatus ? normalizeOrderStatusInput(rawStatus) : null;
    const date_from = parseDateOrNull(req.query.date_from);
    const date_to = parseDateOrNull(req.query.date_to);

    if (rawStatus && !status) {
      return res.status(400).json({ message: "Invalid order status" });
    }

    const where = {
      company_id,
      is_active: true,
      AND: [
        fw
      ]
    };

    const requestedFactoryFilter = buildRequestedFactoryOrderFilter(requestedFactoryId);
    if (requestedFactoryFilter) {
      where.AND.push(requestedFactoryFilter);
    }

    if (client_id) where.client_id = client_id;
    if (sales_company_id) where.sales_company_id = sales_company_id;
    if (status) where.status = status;
    if (date_from || date_to) {
      where.order_date = {};
      if (date_from) where.order_date.gte = date_from;
      if (date_to) where.order_date.lte = date_to;
    }

    const pagination = getPagination(req, { defaultPageSize: 25, maxPageSize: 100 });
    const query = {
      where,
      orderBy: [{ order_date: "desc" }, { id: "desc" }],
      include: {
        client: { select: { id: true, company_name: true } },
        factory: { select: { id: true, name: true } },
        sales_company: { select: { id: true, name: true } },
        _count: { select: { items: true, invoices: true } }
      }
    };

    if (pagination.enabled) {
      query.skip = pagination.skip;
      query.take = pagination.take;
    }

    const [orders, total] = await Promise.all([
      prisma.order.findMany(query),
      pagination.enabled && pagination.include_total ? prisma.order.count({ where }) : Promise.resolve(null)
    ]);

    if (!pagination.enabled) return res.json(orders);

    return res.json({
      items: orders,
      pagination: buildPaginationMeta({
        page: pagination.page,
        page_size: pagination.page_size,
        total: total ?? orders.length
      })
    });
  } catch (err) {
    console.error("getOrders error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// GET /orders/recent?limit=3
// Lightweight list for home dashboard widgets.
exports.getRecentOrders = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const fw = orderVisibilityWhere(req);
    const requestedFactoryId = getRequestedFactoryFilter(req);

    const rawLimit = Number(req.query.limit || 3);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(20, rawLimit)) : 3;

    const where = { company_id, ...fw, is_active: true };

    if (requestedFactoryId) {
      where.OR = [
        { factory_id: requestedFactoryId },
        { fulfillments: { some: { factory_id: requestedFactoryId, is_active: true } } }
      ];
    }

    const rows = await prisma.order.findMany({
      where,
      orderBy: { order_date: "desc" },
      take: limit,
      select: {
        id: true,
        order_no: true,
        order_date: true,
        total: true,
        client: { select: { company_name: true } }
      }
    });

    const out = rows.map((o) => ({
      id: o.id,
      order_no: o.order_no,
      client_name: o.client?.company_name || null,
      total: o.total,
      order_date: o.order_date
    }));

    return res.json(out);
  } catch (err) {
    console.error("getRecentOrders error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getPendingOrders = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const fw = orderVisibilityWhere(req);
    const requestedFactoryId = getRequestedFactoryFilter(req);

    const client_id = (req.query.client_id || "").toString().trim();
    const sales_company_id = (req.query.sales_company_id || "").toString().trim();
    const date_from = parseDateOrNull(req.query.date_from);
    const date_to = parseDateOrNull(req.query.date_to);

    const where = {
      company_id,
      is_active: true,
      status: "CONFIRMED",
      AND: [fw]
    };

    if (requestedFactoryId) {
      where.factory_id = requestedFactoryId;
    }

    if (client_id) where.client_id = client_id;
    if (sales_company_id) where.sales_company_id = sales_company_id;
    if (date_from || date_to) {
      where.order_date = {};
      if (date_from) where.order_date.gte = date_from;
      if (date_to) where.order_date.lte = date_to;
    }

    const pagination = getPagination(req, { defaultPageSize: 25, maxPageSize: 100 });
    const query = {
      where,
      orderBy: [
        { required_by: "asc" },
        { order_date: "asc" },
        { id: "asc" }
      ],
      include: {
        client: { select: { id: true, company_name: true } },
        factory: { select: { id: true, name: true } },
        sales_company: { select: { id: true, name: true } },
        _count: { select: { items: true, invoices: true } }
      }
    };

    if (pagination.enabled) {
      query.skip = pagination.skip;
      query.take = pagination.take;
    }

    const [orders, total] = await Promise.all([
      prisma.order.findMany(query),
      pagination.enabled && pagination.include_total ? prisma.order.count({ where }) : Promise.resolve(null)
    ]);

    if (!pagination.enabled) return res.json(orders);

    return res.json({
      items: orders,
      pagination: buildPaginationMeta({
        page: pagination.page,
        page_size: pagination.page_size,
        total: total ?? orders.length
      })
    });
  } catch (err) {
    console.error("getPendingOrders error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getOrderById = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const fw = orderVisibilityWhere(req);
    const { id } = req.params;

    const order = await prisma.order.findFirst({
      where: { id, company_id, ...fw },
      include: {
        client: true,
        factory: true,
        sales_company: true,
        items: { include: { product: { include: { category: true } } } },
        charges: true,
        fulfillments: {
          where: { is_active: true },
          include: { factory: { select: { id: true, name: true } }, product: { select: { id: true, name: true } } }
        },
        status_history: { orderBy: { created_at: "desc" } },
        invoices: { select: { id: true, invoice_no: true, kind: true, status: true, issue_date: true, total: true } }
      }
    });

    if (!order) return res.status(404).json({ message: "Order not found" });

    // Attach a payment timeline for the order.
    // We compute paid amounts from invoice allocations (source of truth) and also include
    // all payments linked to this order (if populated).
    const invoice = await prisma.invoice.findFirst({
      where: { company_id, order_id: order.id, is_active: true },
      include: {
        allocations: {
          where: { is_active: true },
          include: {
            payment: { select: { id: true, payment_no: true, method: true, paid_at: true, amount: true, status: true } }
          }
        }
      }
    });

    const allocations = (invoice?.allocations || []).filter((a) => a.payment && a.payment.status === "RECORDED");
    const timeline = allocations
      .map((a) => ({
        payment_id: a.payment.id,
        payment_no: a.payment.payment_no || null,
        method: a.payment.method,
        paid_at: a.payment.paid_at,
        payment_amount: a.payment.amount,
        allocated_amount: a.amount
      }))
      .sort((x, y) => new Date(x.paid_at).getTime() - new Date(y.paid_at).getTime());

    const orderTotal = Number(order.total);
    const paidTotal = timeline.reduce((acc, p) => acc + Number(p.allocated_amount || 0), 0);
    const remaining = Math.max(0, orderTotal - paidTotal);

    let running = 0;
    const timelineWithBalance = timeline.map((p) => {
      running += Number(p.allocated_amount || 0);
      return {
        ...p,
        running_paid: running,
        remaining_after: Math.max(0, orderTotal - running)
      };
    });

    return res.json({
      ...order,
      invoice: invoice ? { id: invoice.id, invoice_no: invoice.invoice_no, status: invoice.status, total: invoice.total } : null,
      payments_timeline: timelineWithBalance,
      payment_summary: {
        order_total: order.total,
        paid_total: paidTotal,
        remaining_total: remaining
      }
    });
  } catch (err) {
    console.error("getOrderById error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// POST /orders
exports.createOrder = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const primary_factory_id = requireSingleFactory(req);

    const {
      client_id,
      sales_company_id,
      logistics,
      order_date,
      required_by,
      notes,
      internal_notes,
      items,
      charges
    } = req.body;

    if (!client_id) return res.status(400).json({ message: "client_id is required" });
    if (!sales_company_id) return res.status(400).json({ message: "sales_company_id is required" });
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "items array is required" });
    }

    // Validate base item fields. unit_price is optional (auto-fetched).
    for (const it of items) {
      if (!it.product_id) return res.status(400).json({ message: "Each item requires product_id" });
      const q = Number(it.quantity);
      if (!Number.isFinite(q) || q <= 0) return res.status(400).json({ message: "Item quantity must be > 0" });
      if (it.discount !== undefined && it.discount !== null && Number(it.discount) < 0) {
        return res.status(400).json({ message: "Item discount must be >= 0" });
      }

    }

    const od = parseDateOrNull(order_date) || new Date();
    const rb = parseDateOrNull(required_by) || null;

    const created = await prisma.$transaction(async (tx) => {
      // Sales company (legal entity) must exist (added once by backend ops).
      const salesCompany = await tx.salesCompany.findFirst({
        where: { id: sales_company_id, company_id, is_active: true },
        select: { id: true }
      });
      if (!salesCompany) {
        const err = new Error("SALES_COMPANY_NOT_FOUND");
        err.statusCode = 404;
        throw err;
      }

      const client = await tx.client.findFirst({
        where: { id: client_id, company_id, is_active: true },
        select: { id: true }
      });
      if (!client) {
        const err = new Error("CLIENT_NOT_FOUND");
        err.statusCode = 404;
        throw err;
      }

      // Fetch products with pricing. unit_price is auto-fetched from:
      // 1) ClientProduct.default_price (if present)
      // 2) Product.price
      const productIds = [...new Set(items.map((i) => i.product_id))];
      const products = await tx.product.findMany({
        where: { company_id, id: { in: productIds }, is_active: true },
        select: { id: true, price: true }
      });
      if (products.length !== productIds.length) {
        const err = new Error("PRODUCT_NOT_FOUND");
        err.statusCode = 404;
        throw err;
      }
      const productPrice = new Map(products.map((p) => [p.id, Number(p.price || 0)]));

      const clientProductRows = await tx.clientProduct.findMany({
        where: { company_id, client_id, product_id: { in: productIds } },
        select: { product_id: true, default_price: true, is_active: true }
      });
      const clientDefaultPrice = new Map(
        clientProductRows
          .filter((r) => r.default_price !== null && r.default_price !== undefined)
          .map((r) => [r.product_id, Number(r.default_price)])
      );

      // Auto-map ordered products to the client (first-time order should not require manual mapping).
      // If mapping exists but was inactive, reactivate it.
      for (const pid of productIds) {
        await tx.clientProduct.upsert({
          where: { company_id_client_id_product_id: { company_id, client_id, product_id: pid } },
          create: { company_id, client_id, product_id: pid, is_active: true },
          update: { is_active: true }
        });
      }

      // Dispatch allocations are no longer captured at order creation time.
      // Orders stay in CONFIRMED state first, and stock is deducted only when the
      // order is dispatched/completed later.

      // Build nested creates for items (unit_price auto-fetched if missing).
      const computedItems = items.map((it) => {
        const qty = Number(it.quantity);
        const disc = it.discount !== undefined && it.discount !== null ? Number(it.discount) : 0;

        const supplied = it.unit_price !== undefined && it.unit_price !== null && it.unit_price !== "" ? Number(it.unit_price) : null;
        const fallback = clientDefaultPrice.get(it.product_id) ?? productPrice.get(it.product_id) ?? 0;
        const price = supplied !== null && Number.isFinite(supplied) ? supplied : Number(fallback);

        if (!Number.isFinite(price) || price < 0) {
          const err = new Error("INVALID_PRICE");
          err.statusCode = 400;
          err.meta = { product_id: it.product_id, unit_price: price };
          throw err;
        }

        const line_total = calcLineTotal(qty, price, disc);

        return {
          company: { connect: { id: company_id } },
          product: { connect: { id: it.product_id } },
          quantity: qty,
          unit_price: price,
          discount: disc || null,
          line_total,
          remarks: it.remarks?.toString() || null
        };
      });

      const subtotal = computedItems.reduce((acc, it) => acc + Number(it.line_total), 0);

      const chargesArr = Array.isArray(charges) ? charges : [];
      const computedCharges = chargesArr.map((c) => ({
        company: { connect: { id: company_id } },
        type: c.type || "OTHER",
        title: c.title?.toString() || "Charge",
        amount: Number(c.amount || 0),
        meta: c.meta || null
      }));

      const total_charges = computedCharges.reduce((acc, c) => acc + Number(c.amount || 0), 0);
      const total = Number(subtotal) + Number(total_charges);

      // Create order (primary factory stays required for backward compatibility)
      const order = await tx.order.create({
        data: {
          company: { connect: { id: company_id } },
          factory: { connect: { id: primary_factory_id } },
          client: { connect: { id: client_id } },

          sales_company: { connect: { id: sales_company_id } },
          logistics: logistics !== undefined ? (logistics?.toString() || null) : null,

          order_no: await makeOrderNoTx(tx, company_id, od),
          status: "CONFIRMED",
          order_date: od,
          required_by: rb,

          subtotal,
          total_charges,
          total,

          notes: notes?.toString() || null,
          internal_notes: internal_notes?.toString() || null,
          is_active: true,
          created_by: req.user.id,

          items: { create: computedItems },
          charges: { create: computedCharges },

          status_history: {
            create: {
              company: { connect: { id: company_id } },
              status: "CONFIRMED",
              note: "Order created",
              created_by: req.user.id
            }
          }
        }
      });

      // Auto-create a 1:1 invoice for this order (new invariant).
      await ensureInvoiceForOrderTx(tx, { company_id, order_id: order.id, user_id: req.user.id });

      // Return order with related data (including fulfillments) for UI consumption.
      const full = await tx.order.findFirst({
        where: { id: order.id },
        include: {
          client: { select: { id: true, company_name: true } },
          factory: { select: { id: true, name: true } },
          sales_company: { select: { id: true, name: true } },
          items: { include: { product: { select: { id: true, name: true, unit: true, pack_size: true } } } },
          charges: true,
          fulfillments: {
            where: { is_active: true },
            include: { factory: { select: { id: true, name: true } }, product: { select: { id: true, name: true } } }
          }
        }
      });

      return full;
    }, { maxWait: 5000, timeout: 20000 });

    await logActivity({
      company_id,
      factory_id: primary_factory_id,
      user_id: req.user.id,
      action: "ORDER_CREATED",
      entity_type: "order",
      entity_id: created.id,
      new_value: created
    });

    return res.status(201).json(created);
  } catch (err) {
    if (err && err.message === "SALES_COMPANY_NOT_FOUND") {
      return res.status(404).json({ message: "Sales company not found" });
    }
    if (err && err.message === "CLIENT_NOT_FOUND") {
      return res.status(404).json({ message: "Client not found" });
    }
    if (err && err.message === "PRODUCT_NOT_FOUND") {
      return res.status(404).json({ message: "One or more products not found" });
    }
    if (err && err.message === "FACTORY_NOT_FOUND") {
      return res.status(404).json({ message: "One or more factories not found" });
    }
    if (err && err.message === "UNAUTHORIZED_FACTORY_ACCESS") {
      return res.status(403).json({ message: "Unauthorized factory access", ...err.meta });
    }
    if (err && err.message === "ALLOCATIONS_MISMATCH") {
      return res.status(400).json({ message: "Allocation quantity must match item quantity", ...err.meta });
    }
    if (err && err.message === "INSUFFICIENT_STOCK") {
      return res.status(400).json({ message: "Insufficient stock for one or more items", ...err.meta });
    }
    if (err && err.message === "INVALID_PRICE") {
      return res.status(400).json({ message: "Invalid unit price", ...err.meta });
    }

    console.error("createOrder error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// PUT /orders/:id (editable)
exports.updateOrder = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const factory_id = requireSingleFactory(req);
    const { id } = req.params;

    const existing = await prisma.order.findFirst({
      where: { AND: [ { id, company_id, is_active: true }, orderVisibilityWhere(req) ] },
      include: { items: true, charges: true }
    });
    if (!existing) return res.status(404).json({ message: "Order not found" });

    const {
      required_by,
      notes,
      internal_notes,
      logistics,
      items,
      charges
    } = req.body;

    // In this version, updating items DOES NOT auto-rebalance inventory movements.
    if (items !== undefined) {
      return res.status(400).json({
        message: "Editing order items is not enabled yet in Phase 5. (We can add safe reconciliation in next step.)"
      });
    }

    const rb = required_by !== undefined ? (parseDateOrNull(required_by) || null) : undefined;

    const chargesArr = charges === undefined ? undefined : (Array.isArray(charges) ? charges : []);
    const total_charges = chargesArr ? sumCharges(chargesArr) : existing.total_charges;

    const updated = await prisma.$transaction(async (tx) => {
      // Replace charges if provided
      if (chargesArr !== undefined) {
        await tx.orderCharge.deleteMany({ where: { company_id, order_id: id } });
        if (chargesArr.length > 0) {
          await tx.orderCharge.createMany({
            data: chargesArr.map(c => ({
              company_id,
              order_id: id,
              type: c.type || "OTHER",
              title: c.title?.toString() || "Charge",
              amount: Number(c.amount || 0),
              meta: c.meta || null
            }))
          });
        }
      }

      const total = Number(existing.subtotal) + Number(total_charges);

      const order = await tx.order.update({
        where: { id },
        data: {
          required_by: rb,
          notes: notes !== undefined ? (notes?.toString() || null) : undefined,
          internal_notes: internal_notes !== undefined ? (internal_notes?.toString() || null) : undefined,
          logistics: logistics !== undefined ? (logistics?.toString() || null) : undefined,
          total_charges: chargesArr !== undefined ? total_charges : undefined,
          total: chargesArr !== undefined ? total : undefined
        },
        include: {
          items: true,
          charges: true
        }
      });

      // Keep the 1:1 invoice in sync with the order (items/charges/totals).
      // If the order was created before this invariant existed, this will also create the invoice.
      await syncInvoiceFromOrderTx(tx, {
        company_id,
        order_id: id,
        user_id: req.user.id
      });

      return order;
    });

    await logActivity({
      company_id,
      factory_id,
      user_id: req.user.id,
      action: "ORDER_UPDATED",
      entity_type: "order",
      entity_id: id,
      old_value: existing,
      new_value: updated
    });

    return res.json(updated);
  } catch (err) {
    console.error("updateOrder error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// PUT /orders/:id/status
exports.updateOrderStatus = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const factory_id = requireSingleFactory(req);
    const { id } = req.params;

    const normalizedStatus = normalizeOrderStatusInput(req.body?.status);
    const note = req.body?.note;

    if (!normalizedStatus) {
      return res.status(400).json({ message: "Invalid order status" });
    }

    const existing = await prisma.order.findFirst({
      where: { AND: [{ id, company_id, is_active: true }, orderVisibilityWhere(req)] },
      include: {
        items: { select: { product_id: true, quantity: true } },
        fulfillments: { where: { is_active: true }, select: { id: true, product_id: true, factory_id: true, quantity: true, is_active: true } }
      }
    });
    if (!existing) return res.status(404).json({ message: "Order not found" });

    if (existing.status === "CANCELLED") {
      return res.status(400).json({ message: "Cancelled orders cannot change status" });
    }

    const dispatchNow = isDispatchTriggerStatus(normalizedStatus) && !hasCommittedInventory(existing);

    const updated = await prisma.$transaction(async (tx) => {
      if (dispatchNow) {
        const allocationRows = buildDispatchAllocationRows(existing, req.body || {}, existing.factory_id || factory_id);
        await validateDispatchAllocationsTx(tx, {
          company_id,
          user: req.user,
          order: existing,
          allocationRows
        });

        for (const row of allocationRows) {
          const fulfillment = await tx.orderFulfillment.create({
            data: {
              company_id,
              order_id: existing.id,
              factory_id: row.factory_id,
              product_id: row.product_id,
              quantity: Number(row.quantity),
              is_active: true,
              created_by: req.user.id
            }
          });

          await createMovementTx(tx, {
            company_id,
            factory_id: row.factory_id,
            product_id: row.product_id,
            type: "OUT",
            source_type: "ORDER",
            source_id: fulfillment.id,
            date: new Date(),
            quantity: Number(row.quantity),
            remarks: `Order ${existing.order_no} dispatched`,
            created_by: req.user.id
          });
        }
      }

      const data = { status: normalizedStatus };
      if (["COMPLETED", "DELIVERED"].includes(normalizedStatus)) {
        data.delivered_at = existing.delivered_at || new Date();
      }

      const o = await tx.order.update({
        where: { id },
        data
      });

      await tx.orderStatusHistory.create({
        data: {
          company_id,
          order_id: id,
          status: normalizedStatus,
          note: note?.toString() || null,
          created_by: req.user.id,
          meta: dispatchNow ? { dispatched_now: true } : null
        }
      });

      return o;
    });

    await logActivity({
      company_id,
      factory_id,
      user_id: req.user.id,
      action: dispatchNow ? "ORDER_DISPATCHED" : "ORDER_STATUS_CHANGED",
      entity_type: "order",
      entity_id: id,
      meta: { from: existing.status, to: normalizedStatus, note: note || null, inventory_committed_now: dispatchNow }
    });

    return res.json(updated);
  } catch (err) {
    if (err && err.message === "DISPATCH_ALLOCATIONS_INVALID") {
      return res.status(400).json({ message: "Invalid dispatch factory split", ...err.meta });
    }
    if (err && err.message === "FACTORY_NOT_FOUND") {
      return res.status(404).json({ message: "One or more factories not found", ...err.meta });
    }
    if (err && err.message === "PRODUCT_NOT_FOUND") {
      return res.status(404).json({ message: "One or more products not found", ...err.meta });
    }
    if (err && err.message === "UNAUTHORIZED_FACTORY_ACCESS") {
      return res.status(403).json({ message: "Unauthorized factory access", ...err.meta });
    }
    if (err && err.message === "INSUFFICIENT_STOCK") {
      return res.status(400).json({
        message: err.meta?.details || "Insufficient stock for one or more items",
        ...err.meta
      });
    }

    console.error("updateOrderStatus error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// PUT /orders/:id/cancel
// Cancels an order and reverses its inventory OUT movements by creating RETURN (IN) movements.
// Notes:
// - We do NOT hard-delete records (soft-delete philosophy). We keep the order with status CANCELLED.
// - If invoices exist and are already paid/partially paid/sent/overdue, cancellation is blocked.
exports.cancelOrder = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const request_factory_id = requireSingleFactory(req);
    const { id } = req.params;
    const { note } = req.body || {};

    const existing = await prisma.order.findFirst({
      where: { AND: [ { id, company_id, is_active: true }, orderVisibilityWhere(req) ] },
      include: {
        items: true,
        fulfillments: { where: { is_active: true } },
        invoices: { select: { id: true, status: true } }
      }
    });
    if (!existing) return res.status(404).json({ message: "Order not found" });

    if (existing.status === "CANCELLED") {
      return res.status(400).json({ message: "Order already cancelled" });
    }
    if (["COMPLETED", "DELIVERED", "CLOSED"].includes(existing.status)) {
      return res.status(400).json({ message: "Completed/delivered/closed orders cannot be cancelled" });
    }

    const now = new Date();

    const updated = await prisma.$transaction(async (tx) => {
      const fulfillments = Array.isArray(existing.fulfillments) ? existing.fulfillments : [];

      // Reverse inventory only if stock had already been committed earlier.
      // New CONFIRMED orders do not create OUT movements until dispatch time.
      if (fulfillments.length) {
        for (const f of fulfillments) {
          await createMovementTx(tx, {
            company_id,
            factory_id: f.factory_id,
            product_id: f.product_id,
            type: "IN",
            source_type: "RETURN",
            source_id: existing.id,
            date: now,
            quantity: Number(f.quantity),
            remarks: `Order ${existing.order_no} cancelled - stock returned`,
            created_by: req.user.id
          });
        }
      } else if (isDispatchTriggerStatus(existing.status)) {
        for (const it of existing.items) {
          await createMovementTx(tx, {
            company_id,
            factory_id: existing.factory_id,
            product_id: it.product_id,
            type: "IN",
            source_type: "RETURN",
            source_id: existing.id,
            date: now,
            quantity: Number(it.quantity),
            remarks: `Order ${existing.order_no} cancelled - stock returned`,
            created_by: req.user.id
          });
        }
      }

      // Reverse finance links + void invoices
      if (existing.invoices.length) {
        const invoiceIds = existing.invoices.map((i) => i.id);

        // Soft-reverse allocations so paid totals no longer count
        await tx.paymentAllocation.updateMany({
          where: { company_id, invoice_id: { in: invoiceIds }, is_active: true },
          data: { is_active: false }
        });

        // Mark invoices VOID (keep active for audit)
        await tx.invoice.updateMany({
          where: { company_id, order_id: existing.id, id: { in: invoiceIds } },
          data: { status: "VOID" }
        });

        // Append invoice status timeline entries
        for (const invId of invoiceIds) {
          await tx.invoiceStatusHistory.create({
            data: {
              company_id,
              invoice_id: invId,
              status: "VOID",
              note: `Auto-voided due to order cancellation${note ? `: ${String(note)}` : ""}`,
              created_by: req.user.id
            }
          });
        }
      }

      const o = await tx.order.update({
        where: { id },
        data: { status: "CANCELLED" }
      });

      await tx.orderStatusHistory.create({
        data: {
          company_id,
          order_id: id,
          status: "CANCELLED",
          note: note?.toString() || "Order cancelled",
          created_by: req.user.id
        }
      });

      return o;
    });

    await logActivity({
      company_id,
      factory_id: request_factory_id,
      user_id: req.user.id,
      action: "ORDER_CANCELLED",
      entity_type: "order",
      entity_id: id,
      meta: { note: note || null }
    });

    return res.json(updated);
  } catch (err) {
    console.error("cancelOrder error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

const fs = require("fs");
const { buildTempPdfPath } = require("../utils/fileStorage");
const { streamPdfAndDelete, safeUnlink } = require("../utils/pdfResponse");
const { generateOrderLabelPdfToFile } = require("../services/pdf/orderLabelPdf");
const { generateProformaInvoicePdfToFile } = require("../services/pdf/proformaInvoicePdf");
const { generateProformaPreviewPdfToFile } = require("../services/pdf/proformaInvoicePdf");
const {
  logQueued,
  sendTransactionalEmailPdf,
  sendTransactionalWhatsAppPdf
} = require("../services/messageDispatchService");

exports.getOrderLabelPdf = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const fw = orderVisibilityWhere(req);
    const { id } = req.params;

    const order = await prisma.order.findFirst({
      where: { id, company_id, ...fw, is_active: true },
      select: { id: true, factory_id: true, updated_at: true }
    });
    if (!order) return res.status(404).json({ message: "Order not found" });

    const factory_id = order.factory_id;

    const outPath = buildTempPdfPath("order-label", company_id, factory_id, id);
    await generateOrderLabelPdfToFile({ company_id, factory_id, orderId: id, outPath });

    return streamPdfAndDelete({
      res,
      filePath: outPath,
      filename: `order-label-${id}.pdf`,
      inline: true
    });
  } catch (err) {
    console.error("getOrderLabelPdf error:", err);
    return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
  }
};

exports.getOrderProformaPdf = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const fw = orderVisibilityWhere(req);
    const { id } = req.params;

    const order = await prisma.order.findFirst({
      where: { id, company_id, ...fw, is_active: true },
      select: { id: true, factory_id: true, updated_at: true }
    });
    if (!order) return res.status(404).json({ message: "Order not found" });

    const factory_id = order.factory_id;

    const outPath = buildTempPdfPath("proforma-invoice", company_id, factory_id, id);
    await generateProformaInvoicePdfToFile({ company_id, factory_id, orderId: id, outPath });

    return streamPdfAndDelete({
      res,
      filePath: outPath,
      filename: `proforma-${id}.pdf`,
      inline: true
    });
  } catch (err) {
    console.error("getOrderProformaPdf error:", err);
    return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
  }
};


exports.sendOrderLabel = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const fw = orderVisibilityWhere(req);
    const { id } = req.params;

    const { channel, to_email, to_phone, subject, message } = req.body;

    if (!channel || !["EMAIL", "WHATSAPP"].includes(channel)) {
      return res.status(400).json({ message: "channel must be EMAIL or WHATSAPP" });
    }

    const order = await prisma.order.findFirst({
      where: { id, company_id, ...fw, is_active: true },
      include: { client: true }
    });
    if (!order) return res.status(404).json({ message: "Order not found" });

    const factory_id = order.factory_id;

    const outPath = buildTempPdfPath("order-label", company_id, factory_id, id);
    await generateOrderLabelPdfToFile({ company_id, factory_id, orderId: id, outPath });

    const defaultSubject = `Order Label - ${order.order_no}`;
    const defaultMsg = `Order label for ${order.client.company_name} (${order.order_no}).`;

    if (channel === "EMAIL") {
      if (!to_email) return res.status(400).json({ message: "to_email is required" });

      const log = await logQueued({
        company_id,
        channel: "EMAIL",
        to: to_email,
        created_by: req.user.id,
        factory_id,
        client_id: order.client_id,
        order_id: id,
        payload: { order_no: order.order_no }
      });

      const resp = await sendTransactionalEmailPdf({
        req,
        company_id,
        toEmail: to_email,
        toName: null,
        subject: subject || defaultSubject,
        html: `<p>${message || defaultMsg}</p>`,
        pdfPath: outPath,
        logId: log.id
      });

      safeUnlink(outPath);
      return res.json({ ok: true, log_id: log.id, provider: resp });
    }

    // WHATSAPP
    if (!to_phone) return res.status(400).json({ message: "to_phone is required" });

    const log = await logQueued({
      company_id,
      channel: "WHATSAPP",
      to: to_phone,
      created_by: req.user.id,
      factory_id,
      client_id: order.client_id,
      order_id: id,
      payload: { order_no: order.order_no }
    });

    const resp = await sendTransactionalWhatsAppPdf({
      req,
      company_id,
      toPhone: to_phone,
      caption: message || defaultMsg,
      pdfPath: outPath,
      logId: log.id
    });

    safeUnlink(outPath);
    return res.json({ ok: true, log_id: log.id, provider: resp });
  } catch (err) {
    console.error("sendOrderLabel error:", err);
    return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
  }
};

exports.proformaPreviewFromPayload = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const factory_id = requireSingleFactory(req);

    const payload = req.body || {};
    const { client_id, sales_company_id, items, charges, notes, order_date } = payload;

    if (!client_id) return res.status(400).json({ message: "client_id is required" });
    if (!sales_company_id) return res.status(400).json({ message: "sales_company_id is required" });
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "items array is required" });
    }

    for (const it of items) {
      if (!it.product_id) return res.status(400).json({ message: "Each item requires product_id" });
      const q = Number(it.quantity);
      if (!Number.isFinite(q) || q <= 0) return res.status(400).json({ message: "Item quantity must be > 0" });
    }

    const [client, sales_company] = await Promise.all([
      prisma.client.findFirst({ where: { id: client_id, company_id, is_active: true } }),
      prisma.salesCompany.findFirst({ where: { id: sales_company_id, company_id, is_active: true } })
    ]);

    if (!client) return res.status(404).json({ message: "Client not found" });
    if (!sales_company) return res.status(404).json({ message: "Sales company not found" });

    // Resolve products (need product object for invoicePdf table)
    const productIds = [...new Set(items.map((i) => i.product_id))];

    const products = await prisma.product.findMany({
      where: { company_id, id: { in: productIds }, is_active: true },
      include: { category: true }
    });
    if (products.length !== productIds.length) {
      return res.status(404).json({ message: "One or more products not found" });
    }
    const productMap = new Map(products.map((p) => [p.id, p]));

    // ClientProduct default price (optional)
    const clientPrices = await prisma.clientProduct.findMany({
      where: { company_id, client_id, product_id: { in: productIds }, is_active: true },
      select: { product_id: true, default_price: true }
    });
    const clientPriceMap = new Map(clientPrices.map((cp) => [cp.product_id, cp.default_price]));

    const normalizedItems = items.map((it) => {
      const p = productMap.get(it.product_id);

      const qty = Number(it.quantity);
      const discount = toNumber(it.discount || 0);

      const resolvedUnitPrice =
        it.unit_price !== undefined && it.unit_price !== null && it.unit_price !== ""
          ? toNumber(it.unit_price)
          : toNumber(clientPriceMap.get(it.product_id) ?? p.price);

      const line_total = Math.max(qty * resolvedUnitPrice - discount, 0);

      return {
        quantity: qty,
        unit_price: resolvedUnitPrice,
        line_total,
        product: p
      };
    });

    const normalizedCharges = Array.isArray(charges)
      ? charges.map((c) => ({
          type: c.type || "OTHER",
          title: c.title?.toString() || "Charge",
          amount: toNumber(c.amount || 0),
          meta: c.meta || null
        }))
      : [];

    const outPath = buildTempPdfPath("proforma-preview", company_id, factory_id, "preview");
    await generateProformaPreviewPdfToFile({
      company_id,
      factory_id,
      client,
      sales_company,
      items: normalizedItems,
      charges: normalizedCharges,
      issue_date: order_date || new Date(),
      notes: notes || null,
      outPath
    });

    return streamPdfAndDelete({
      res,
      filePath: outPath,
      filename: `proforma-preview.pdf`,
      inline: true
    });
  } catch (err) {
    console.error("proformaPreviewFromPayload error:", err);
    return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
  }
};