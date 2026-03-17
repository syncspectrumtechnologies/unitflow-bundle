const prisma = require("../config/db");
const logActivity = require("../utils/activityLogger");
const stockService = require("../services/stockService");
const { createMovementTx } = require("../services/inventoryLedgerService");
const { getPagination, buildPaginationMeta } = require("../utils/pagination");
const { factoryWhere, requireSingleFactory } = require("../utils/factoryScope");

function parseDateOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function validateQtyPositive(quantity) {
  const q = Number(quantity);
  if (!Number.isFinite(q) || q <= 0) return null;
  return q;
}

function parseBoolean(v) {
  if (v === undefined || v === null) return false;
  const s = String(v).trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

exports.createIn = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const factory_id = requireSingleFactory(req);

    const { product_id, quantity, date, remarks, unit_cost } = req.body;

    if (!product_id) return res.status(400).json({ message: "product_id is required" });

    const qty = validateQtyPositive(quantity);
    if (!qty) return res.status(400).json({ message: "quantity must be a number > 0" });

    const movementDate = parseDateOrNull(date) || new Date();

    const product = await prisma.product.findFirst({
      where: { id: product_id, company_id, is_active: true },
      select: { id: true }
    });
    if (!product) return res.status(404).json({ message: "Product not found" });

    const { movement } = await prisma.$transaction((tx) => createMovementTx(tx, {
      company_id,
      factory_id,
      product_id,
      type: "IN",
      source_type: "MANUAL",
      source_id: null,
      date: movementDate,
      quantity: qty,
      unit_cost: unit_cost !== undefined && unit_cost !== null ? unit_cost : null,
      remarks: remarks?.toString() || null,
      created_by: req.user.id
    }));

    await logActivity({
      company_id,
      factory_id,
      user_id: req.user.id,
      action: "INVENTORY_IN_CREATED",
      entity_type: "inventory_movement",
      entity_id: movement.id,
      new_value: movement
    });

    return res.status(201).json(movement);
  } catch (err) {
    console.error("createIn error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.createOut = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const factory_id = requireSingleFactory(req);

    const { product_id, quantity, date, remarks } = req.body;

    if (!product_id) return res.status(400).json({ message: "product_id is required" });

    const qty = validateQtyPositive(quantity);
    if (!qty) return res.status(400).json({ message: "quantity must be a number > 0" });

    const movementDate = parseDateOrNull(date) || new Date();

    const product = await prisma.product.findFirst({
      where: { id: product_id, company_id, is_active: true },
      select: { id: true }
    });
    if (!product) return res.status(404).json({ message: "Product not found" });

    let movement;
    try {
      ({ movement } = await prisma.$transaction((tx) => createMovementTx(tx, {
        company_id,
        factory_id,
        product_id,
        type: "OUT",
        source_type: "MANUAL",
        source_id: null,
        date: movementDate,
        quantity: qty,
        remarks: remarks?.toString() || null,
        created_by: req.user.id
      })));
    } catch (err) {
      if (err?.message === "INSUFFICIENT_STOCK") {
        return res.status(400).json({ message: "Insufficient stock", ...err.meta });
      }
      throw err;
    }

    await logActivity({
      company_id,
      factory_id,
      user_id: req.user.id,
      action: "INVENTORY_OUT_CREATED",
      entity_type: "inventory_movement",
      entity_id: movement.id,
      new_value: movement
    });

    return res.status(201).json(movement);
  } catch (err) {
    console.error("createOut error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.createAdjustment = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const factory_id = requireSingleFactory(req);

    const { product_id, quantity, date, remarks } = req.body;

    if (!product_id) return res.status(400).json({ message: "product_id is required" });

    const q = Number(quantity);
    if (!Number.isFinite(q) || q === 0) {
      return res.status(400).json({ message: "quantity must be a non-zero number (can be negative)" });
    }

    const movementDate = parseDateOrNull(date) || new Date();

    const product = await prisma.product.findFirst({
      where: { id: product_id, company_id, is_active: true },
      select: { id: true }
    });
    if (!product) return res.status(404).json({ message: "Product not found" });

    let movement;
    try {
      ({ movement } = await prisma.$transaction((tx) => createMovementTx(tx, {
        company_id,
        factory_id,
        product_id,
        type: "ADJUSTMENT",
        source_type: "MANUAL",
        source_id: null,
        date: movementDate,
        quantity: q,
        remarks: remarks?.toString() || null,
        created_by: req.user.id
      }, { allowNegativeAdjustment: true })));
    } catch (err) {
      if (err?.message === "INSUFFICIENT_STOCK") {
        return res.status(400).json({ message: "Insufficient stock", ...err.meta });
      }
      throw err;
    }

    await logActivity({
      company_id,
      factory_id,
      user_id: req.user.id,
      action: "INVENTORY_ADJUSTMENT_CREATED",
      entity_type: "inventory_movement",
      entity_id: movement.id,
      new_value: movement
    });

    return res.status(201).json(movement);
  } catch (err) {
    console.error("createAdjustment error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getMovements = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const fw = factoryWhere(req);

    const product_id = (req.query.product_id || "").toString().trim();
    const type = (req.query.type || "").toString().trim(); // IN/OUT/ADJUSTMENT
    const source_type = (req.query.source_type || "").toString().trim(); // PRODUCTION/ORDER/MANUAL...
    const date_from = parseDateOrNull(req.query.date_from);
    const date_to = parseDateOrNull(req.query.date_to);

    const where = { company_id, ...fw };

    if (product_id) where.product_id = product_id;
    if (type) where.type = type;
    if (source_type) where.source_type = source_type;

    if (date_from || date_to) {
      where.date = {};
      if (date_from) where.date.gte = date_from;
      if (date_to) where.date.lte = date_to;
    }

    const pagination = getPagination(req, { defaultPageSize: 50, maxPageSize: 200 });
    const query = {
      where,
      orderBy: [{ date: "desc" }, { id: "desc" }],
      include: {
        factory: { select: { id: true, name: true } },
        product: {
          select: {
            id: true,
            name: true,
            unit: true,
            pack_size: true,
            category: { select: { id: true, name: true } }
          }
        }
      }
    };

    if (pagination.enabled) {
      query.skip = pagination.skip;
      query.take = pagination.take;
    }

    const [rows, total] = await Promise.all([
      prisma.inventoryMovement.findMany(query),
      pagination.enabled && pagination.include_total ? prisma.inventoryMovement.count({ where }) : Promise.resolve(null)
    ]);

    if (!pagination.enabled) return res.json(rows);

    return res.json({
      items: rows,
      pagination: buildPaginationMeta({ page: pagination.page, page_size: pagination.page_size, total: total ?? rows.length })
    });
  } catch (err) {
    console.error("getMovements error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// GET /inventory/stock-summary?product_id=...
exports.getStockSummary = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const factory_id = req.factory_id;

    const product_id = (req.query.product_id || "").toString().trim();
    const date_from = parseDateOrNull(req.query.date_from);
    const date_to = parseDateOrNull(req.query.date_to);
    const as_of = parseDateOrNull(req.query.as_of);

    if (!product_id) {
      return res.status(400).json({ message: "product_id is required" });
    }

    if (date_from && as_of) {
      return res.status(400).json({ message: "Use either date_from/date_to or as_of, not both" });
    }

    if (!factory_id && Array.isArray(req.factory_ids) && req.factory_ids.length) {
      const summary = await stockService.getFactoriesProductSummary(company_id, req.factory_ids, product_id, {
        date_from,
        date_to,
        as_of
      });

      if (!summary) return res.status(404).json({ message: "Product not found" });
      return res.json(summary);
    }

    const summary = await stockService.getFactoryProductSummary(company_id, factory_id, product_id, {
      date_from,
      date_to,
      as_of
    });

    if (!summary) return res.status(404).json({ message: "Product not found" });
    return res.json(summary);
  } catch (err) {
    console.error("getStockSummary error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// GET /inventory/stock
exports.getStock = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const factory_id = req.factory_id;

    const category_id = (req.query.category_id || "").toString().trim();
    const product_id = (req.query.product_id || "").toString().trim();

    const include_totals = parseBoolean(req.query.include_totals);

    // Optional time-based reporting
    const as_of = parseDateOrNull(req.query.as_of);
    const date_from = parseDateOrNull(req.query.date_from);
    const date_to = parseDateOrNull(req.query.date_to);

    // Safe shortcut:
    // If frontend needs movement totals for a single product, allow using the same endpoint
    // with include_totals=true&product_id=...
    if (include_totals) {
      if (!product_id) {
        return res.status(400).json({
          message: "product_id is required when include_totals=true. Use /inventory/stock for list view and /inventory/stock-summary for product summary."
        });
      }

      if (!factory_id && Array.isArray(req.factory_ids) && req.factory_ids.length) {
        const summary = await stockService.getFactoriesProductSummary(company_id, req.factory_ids, product_id, {
          date_from,
          date_to,
          as_of
        });
        if (!summary) return res.status(404).json({ message: "Product not found" });
        return res.json(summary);
      }

      const summary = await stockService.getFactoryProductSummary(company_id, factory_id, product_id, {
        date_from,
        date_to,
        as_of
      });
      if (!summary) return res.status(404).json({ message: "Product not found" });
      return res.json(summary);
    }

    // If factory_id is null, we are in "all factories" view.
    if (!factory_id && Array.isArray(req.factory_ids) && req.factory_ids.length) {
      const factory_ids = req.factory_ids;

      if (date_from || date_to) {
        const report = await stockService.getFactoriesStockPeriod(company_id, factory_ids, {
          category_id: category_id || undefined,
          product_id: product_id || undefined,
          date_from,
          date_to
        });
        return res.json(report);
      }

      if (as_of) {
        const report = await stockService.getFactoriesStockAsOf(company_id, factory_ids, {
          category_id: category_id || undefined,
          product_id: product_id || undefined,
          as_of
        });
        return res.json(report);
      }

      const stock = await stockService.getFactoriesStock(company_id, factory_ids, {
        category_id,
        product_id
      });
      return res.json(stock);
    }

    // Single factory view
    if (date_from || date_to) {
      const report = await stockService.getFactoryStockPeriod(company_id, factory_id, {
        category_id: category_id || undefined,
        product_id: product_id || undefined,
        date_from,
        date_to
      });
      return res.json(report);
    }

    if (as_of) {
      const report = await stockService.getFactoryStockAsOf(company_id, factory_id, {
        category_id: category_id || undefined,
        product_id: product_id || undefined,
        as_of
      });
      return res.json(report);
    }

    const stock = await stockService.getFactoryStock(company_id, factory_id, {
      category_id,
      product_id
    });

    return res.json(stock);
  } catch (err) {
    console.error("getStock error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};