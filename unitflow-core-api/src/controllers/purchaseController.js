const prisma = require("../config/db");
const logActivity = require("../utils/activityLogger");
const fs = require("fs");
const { buildTempPdfPath } = require("../utils/fileStorage");
const { streamPdfAndDelete } = require("../utils/pdfResponse");
const { generatePurchasePdfToFile } = require("../services/pdf/purchasePdf");
const { factoryWhere, requireSingleFactory } = require("../utils/factoryScope");
const { getPagination, buildPaginationMeta } = require("../utils/pagination");
const { buildPurchaseItemsFromPayloadTx, summarizeCharges } = require("../services/documentTaxService");
const { inferStateCode, resolveSupplyType, normalizeText, round2, toNumber, summarizeTaxLines } = require("../services/gstService");
const { createMovementTx } = require("../services/inventoryLedgerService");
const { makePurchaseReceiptNoTx, makeSupplierReturnNoTx } = require("../utils/numbering");

function parseDateOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function cleanNullableText(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function normalizePurchaseStatus(status, fallback = null) {
  const raw = String(status || fallback || "").trim().toUpperCase();
  const allowed = new Set(["DRAFT", "ORDERED", "PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED", "CLOSED"]);
  return allowed.has(raw) ? raw : fallback;
}

function normalizeReceiptStatus(status, fallback = null) {
  const raw = String(status || fallback || "").trim().toUpperCase();
  const allowed = new Set(["DRAFT", "APPROVED", "DISPATCHED", "COMPLETED", "CANCELLED"]);
  return allowed.has(raw) ? raw : fallback;
}

function normalizeReturnStatus(status, fallback = null) {
  const raw = String(status || fallback || "").trim().toUpperCase();
  const allowed = new Set(["DRAFT", "POSTED", "CANCELLED"]);
  return allowed.has(raw) ? raw : fallback;
}

function purchaseInclude() {
  return {
    factory: { select: { id: true, name: true, state: true, state_code: true } },
    items: { include: { product: { select: { id: true, name: true, sku: true, unit: true, tracking_mode: true } } }, orderBy: { created_at: "asc" } },
    charges: { orderBy: { created_at: "asc" } },
    timeline: { orderBy: { created_at: "asc" } },
    receipts: {
      orderBy: [{ receipt_date: "desc" }, { id: "desc" }],
      include: {
        items: { include: { product: { select: { id: true, name: true, sku: true, unit: true, tracking_mode: true } }, purchase_item: true } }
      }
    },
    returns: {
      orderBy: [{ return_date: "desc" }, { id: "desc" }],
      include: {
        items: { include: { product: { select: { id: true, name: true, sku: true, unit: true, tracking_mode: true } }, purchase_item: true } }
      }
    }
  };
}

function purchaseSummary(purchase) {
  const ordered_qty = round2((purchase.items || []).reduce((sum, item) => sum + toNumber(item.quantity), 0));
  const received_qty = round2((purchase.items || []).reduce((sum, item) => sum + toNumber(item.received_quantity), 0));
  const returned_qty = round2((purchase.items || []).reduce((sum, item) => sum + toNumber(item.returned_quantity), 0));
  const pending_qty = round2(Math.max(0, ordered_qty - received_qty));
  return {
    ordered_qty,
    received_qty,
    returned_qty,
    pending_qty,
    receipt_count: purchase.receipts?.length || 0,
    return_count: purchase.returns?.length || 0,
    is_fully_received: pending_qty <= 0.000001
  };
}

async function getPurchaseOr404({ company_id, purchase_id, factoryFilter }) {
  const purchase = await prisma.purchase.findFirst({
    where: { id: purchase_id, company_id, ...(factoryFilter || {}), is_active: true },
    include: purchaseInclude()
  });
  if (!purchase) {
    const err = new Error("Purchase not found");
    err.statusCode = 404;
    throw err;
  }
  return purchase;
}

function derivePurchaseLifecycleStatus(items = [], currentStatus = null) {
  if (["CANCELLED", "CLOSED"].includes(String(currentStatus || "").toUpperCase())) return currentStatus;
  const totalOrdered = round2(items.reduce((sum, row) => sum + toNumber(row.quantity), 0));
  const totalReceived = round2(items.reduce((sum, row) => sum + toNumber(row.received_quantity), 0));
  if (totalOrdered <= 0) return currentStatus || "DRAFT";
  if (totalReceived <= 0) return currentStatus === "DRAFT" ? "DRAFT" : "ORDERED";
  if (totalReceived < totalOrdered) return "PARTIALLY_RECEIVED";
  return "RECEIVED";
}

async function buildPurchaseMutation(tx, { company_id, purchase, body, factory_id }) {
  const nextFactoryId = factory_id || purchase?.factory_id;
  const purchaseDate = parseDateOrNull(body.purchase_date) || purchase?.purchase_date || new Date();
  const vendorStateCode = inferStateCode({
    gstin: body.vendor_gstin !== undefined ? body.vendor_gstin : purchase?.vendor_gstin,
    state_code: body.vendor_state_code !== undefined ? body.vendor_state_code : purchase?.vendor_state_code
  });
  const company = await tx.company.findFirst({ where: { id: company_id } });
  const buyerStateCode = inferStateCode({ gstin: company?.gstin, state_code: company?.state_code });
  const supply_type = resolveSupplyType({
    seller_state_code: vendorStateCode,
    buyer_state_code: body.place_of_supply_code || buyerStateCode,
    gst_registration_type: body.vendor_gst_registration_type || purchase?.vendor_gst_registration_type || "REGISTERED"
  });

  const normalizedCharges = summarizeCharges(body.charges !== undefined ? body.charges : (purchase?.charges || []));
  const chargeTotal = round2(normalizedCharges.reduce((sum, row) => sum + toNumber(row.amount), 0));
  const roundOff = body.round_off !== undefined ? round2(toNumber(body.round_off)) : round2(toNumber(purchase?.round_off || 0));

  const itemPayload = body.items !== undefined
    ? body.items
    : (purchase?.items || []).map((item) => ({
      product_id: item.product_id,
      description: item.description,
      unit: item.unit,
      quantity: toNumber(item.quantity),
      unit_price: toNumber(item.unit_price),
      discount: item.discount !== null && item.discount !== undefined ? toNumber(item.discount) : null,
      hsn_sac_code: item.hsn_sac_code,
      gst_rate: item.gst_rate !== null && item.gst_rate !== undefined ? toNumber(item.gst_rate) : undefined,
      cess_rate: item.cess_rate !== null && item.cess_rate !== undefined ? toNumber(item.cess_rate) : undefined
    }));

  if (!Array.isArray(itemPayload) || itemPayload.length === 0) {
    const err = new Error("items must be a non-empty array");
    err.statusCode = 400;
    throw err;
  }

  const built = await buildPurchaseItemsFromPayloadTx(tx, { company_id, items: itemPayload, supply_type });
  const totals = summarizeTaxLines(built.items, chargeTotal, roundOff);

  return {
    nextFactoryId,
    purchaseDate,
    vendorStateCode,
    supply_type,
    items: built.items,
    charges: normalizedCharges,
    totals,
    mutationData: {
      factory_id: nextFactoryId,
      purchase_no: body.purchase_no !== undefined ? String(body.purchase_no).trim() : purchase?.purchase_no,
      purchase_date: purchaseDate,
      vendor_name: body.vendor_name !== undefined ? String(body.vendor_name).trim() : purchase?.vendor_name,
      vendor_gstin: cleanNullableText(body.vendor_gstin !== undefined ? body.vendor_gstin : purchase?.vendor_gstin),
      vendor_gst_registration_type: body.vendor_gst_registration_type !== undefined
        ? (body.vendor_gst_registration_type ? String(body.vendor_gst_registration_type).trim().toUpperCase() : null)
        : purchase?.vendor_gst_registration_type,
      vendor_phone: cleanNullableText(body.vendor_phone !== undefined ? body.vendor_phone : purchase?.vendor_phone),
      vendor_email: cleanNullableText(body.vendor_email !== undefined ? body.vendor_email : purchase?.vendor_email),
      vendor_address: cleanNullableText(body.vendor_address !== undefined ? body.vendor_address : purchase?.vendor_address),
      vendor_state: cleanNullableText(body.vendor_state !== undefined ? body.vendor_state : purchase?.vendor_state),
      vendor_state_code: vendorStateCode,
      supply_type,
      notes: cleanNullableText(body.notes !== undefined ? body.notes : purchase?.notes),
      subtotal: totals.subtotal,
      tax_subtotal: totals.tax_subtotal,
      total_charges: totals.total_charges,
      cgst_total: totals.cgst_total,
      sgst_total: totals.sgst_total,
      igst_total: totals.igst_total,
      cess_total: totals.cess_total,
      round_off: totals.round_off,
      total: totals.total,
      gst_breakup: totals.gst_breakup
    }
  };
}

exports.getPurchases = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const fw = factoryWhere(req);

    const q = (req.query.q || "").toString().trim();
    const status = (req.query.status || "").toString().trim();
    const date_from = parseDateOrNull(req.query.date_from);
    const date_to = parseDateOrNull(req.query.date_to);
    const vendor_gstin = (req.query.vendor_gstin || "").toString().trim();

    const where = { company_id, ...fw, is_active: true };
    if (q) {
      where.OR = [
        { purchase_no: { contains: q, mode: "insensitive" } },
        { vendor_name: { contains: q, mode: "insensitive" } },
        { vendor_phone: { contains: q, mode: "insensitive" } },
        { vendor_email: { contains: q, mode: "insensitive" } },
        { vendor_gstin: { contains: q, mode: "insensitive" } }
      ];
    }
    if (status) where.status = normalizePurchaseStatus(status, status);
    if (vendor_gstin) where.vendor_gstin = { contains: vendor_gstin, mode: "insensitive" };
    if (date_from || date_to) {
      where.purchase_date = { ...(date_from ? { gte: date_from } : {}), ...(date_to ? { lte: date_to } : {}) };
    }

    const pagination = getPagination(req, { defaultPageSize: 25, maxPageSize: 100 });
    const query = {
      where,
      orderBy: [{ purchase_date: "desc" }, { updated_at: "desc" }, { id: "desc" }],
      include: {
        factory: { select: { id: true, name: true } },
        items: { select: { id: true, quantity: true, received_quantity: true, returned_quantity: true } },
        _count: { select: { items: true, charges: true, receipts: true, returns: true } }
      }
    };
    if (pagination.enabled) {
      query.skip = pagination.skip;
      query.take = pagination.take;
    }

    const [rows, total] = await Promise.all([
      prisma.purchase.findMany(query),
      pagination.enabled && pagination.include_total ? prisma.purchase.count({ where }) : Promise.resolve(null)
    ]);

    const shaped = rows.map((row) => ({ ...row, summary: purchaseSummary(row) }));
    if (!pagination.enabled) return res.json({ count: shaped.length, rows: shaped });

    return res.json({
      count: total ?? shaped.length,
      rows: shaped,
      pagination: buildPaginationMeta({ page: pagination.page, page_size: pagination.page_size, total: total ?? shaped.length })
    });
  } catch (err) {
    console.error("getPurchases error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getPurchaseById = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const fw = factoryWhere(req);
    const { id } = req.params;
    const purchase = await getPurchaseOr404({ company_id, purchase_id: id, factoryFilter: fw });
    return res.json({ ...purchase, summary: purchaseSummary(purchase) });
  } catch (err) {
    console.error("getPurchaseById error:", err);
    return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
  }
};

exports.createPurchase = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const factory_id = requireSingleFactory(req);

    if (!req.body?.vendor_name || !String(req.body.vendor_name).trim()) {
      return res.status(400).json({ message: "vendor_name is required" });
    }

    const created = await prisma.$transaction(async (tx) => {
      const prepared = await buildPurchaseMutation(tx, { company_id, body: req.body || {}, factory_id });
      const purchaseNo = prepared.mutationData.purchase_no || `PO-${Date.now()}`;

      const po = await tx.purchase.create({
        data: {
          company_id,
          created_by: req.user.id,
          status: normalizePurchaseStatus(req.body.status, "DRAFT") || "DRAFT",
          ...prepared.mutationData,
          purchase_no: purchaseNo,
          is_active: true
        }
      });

      await tx.purchaseItem.createMany({
        data: prepared.items.map((item) => ({
          company_id,
          purchase_id: po.id,
          ...item
        }))
      });

      if (prepared.charges.length) {
        await tx.purchaseCharge.createMany({
          data: prepared.charges.map((charge) => ({
            company_id,
            purchase_id: po.id,
            type: charge.type || "OTHER",
            label: charge.label || charge.title || "Charge",
            amount: charge.amount,
            meta: charge.meta || null
          }))
        });
      }

      await tx.purchaseStatusHistory.create({
        data: {
          company_id,
          purchase_id: po.id,
          status: normalizePurchaseStatus(req.body.status, "DRAFT") || "DRAFT",
          note: "Created",
          created_by: req.user.id
        }
      });

      return tx.purchase.findUnique({ where: { id: po.id }, include: purchaseInclude() });
    });

    await logActivity({ company_id, factory_id, user_id: req.user.id, action: "PURCHASE_CREATED", entity_type: "purchase", entity_id: created.id });
    return res.status(201).json({ ...created, summary: purchaseSummary(created) });
  } catch (err) {
    console.error("createPurchase error:", err);
    return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
  }
};

exports.updatePurchase = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const { id } = req.params;
    const fw = factoryWhere(req);

    const existing = await getPurchaseOr404({ company_id, purchase_id: id, factoryFilter: fw });
    if (!["DRAFT", "ORDERED", "PARTIALLY_RECEIVED"].includes(existing.status)) {
      return res.status(400).json({ message: "Only DRAFT / ORDERED / PARTIALLY_RECEIVED purchases can be edited" });
    }

    if (req.body.items !== undefined && ((existing.receipts?.length || 0) > 0 || (existing.returns?.length || 0) > 0)) {
      return res.status(400).json({ message: "Items cannot be edited after receipts/returns exist. Create a new purchase or use returns/receipts workflows instead." });
    }

    const updated = await prisma.$transaction(async (tx) => {
      const prepared = await buildPurchaseMutation(tx, { company_id, purchase: existing, body: req.body || {} });

      await tx.purchase.update({
        where: { id },
        data: {
          ...prepared.mutationData,
          status: req.body.status ? normalizePurchaseStatus(req.body.status, existing.status) : existing.status
        }
      });

      if (req.body.items !== undefined) {
        const receivedMap = new Map(existing.items.map((item) => [item.id, { received_quantity: item.received_quantity, returned_quantity: item.returned_quantity }]));
        await tx.purchaseItem.deleteMany({ where: { purchase_id: id, company_id } });
        await tx.purchaseItem.createMany({
          data: prepared.items.map((item, idx) => ({
            company_id,
            purchase_id: id,
            ...item,
            received_quantity: 0,
            returned_quantity: 0
          }))
        });
      }

      if (req.body.charges !== undefined) {
        await tx.purchaseCharge.deleteMany({ where: { purchase_id: id, company_id } });
        if (prepared.charges.length) {
          await tx.purchaseCharge.createMany({
            data: prepared.charges.map((charge) => ({
              company_id,
              purchase_id: id,
              type: charge.type || "OTHER",
              label: charge.label || charge.title || "Charge",
              amount: charge.amount,
              meta: charge.meta || null
            }))
          });
        }
      }

      return tx.purchase.findUnique({ where: { id }, include: purchaseInclude() });
    });

    await logActivity({ company_id, factory_id: updated.factory_id, user_id: req.user.id, action: "PURCHASE_UPDATED", entity_type: "purchase", entity_id: id });
    return res.json({ ...updated, summary: purchaseSummary(updated) });
  } catch (err) {
    console.error("updatePurchase error:", err);
    return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
  }
};

exports.updatePurchaseStatus = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const fw = factoryWhere(req);
    const { id } = req.params;
    const { status, note } = req.body || {};
    if (!status) return res.status(400).json({ message: "status is required" });

    const existing = await getPurchaseOr404({ company_id, purchase_id: id, factoryFilter: fw });
    const nextStatus = normalizePurchaseStatus(status);
    if (!nextStatus) return res.status(400).json({ message: "Invalid status" });

    const updated = await prisma.$transaction(async (tx) => {
      const po = await tx.purchase.update({ where: { id }, data: { status: nextStatus } });
      await tx.purchaseStatusHistory.create({
        data: { company_id, purchase_id: id, status: nextStatus, note: note?.toString() || null, created_by: req.user.id }
      });
      return tx.purchase.findUnique({ where: { id }, include: purchaseInclude() });
    });

    await logActivity({ company_id, factory_id: existing.factory_id, user_id: req.user.id, action: "PURCHASE_STATUS_UPDATED", entity_type: "purchase", entity_id: id });
    return res.json({ ...updated, summary: purchaseSummary(updated) });
  } catch (err) {
    console.error("updatePurchaseStatus error:", err);
    return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
  }
};

exports.getPurchaseReceipts = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const fw = factoryWhere(req);
    const purchase_id = req.params.id;
    const where = { company_id, ...(purchase_id ? { purchase_id } : {}), ...(fw.factory_id ? { factory_id: fw.factory_id } : {}) };
    const rows = await prisma.purchaseReceipt.findMany({
      where,
      orderBy: [{ receipt_date: "desc" }, { id: "desc" }],
      include: { purchase: { select: { id: true, purchase_no: true, vendor_name: true } }, items: { include: { product: true, purchase_item: true } } }
    });
    return res.json({ count: rows.length, rows });
  } catch (err) {
    console.error("getPurchaseReceipts error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getPurchaseReceiptById = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const fw = factoryWhere(req);
    const { receiptId } = req.params;
    const row = await prisma.purchaseReceipt.findFirst({
      where: { id: receiptId, company_id, ...(fw.factory_id ? { factory_id: fw.factory_id } : {}) },
      include: {
        purchase: { include: { items: true, charges: true } },
        items: { include: { product: true, purchase_item: true } }
      }
    });
    if (!row) return res.status(404).json({ message: "Receipt not found" });
    return res.json(row);
  } catch (err) {
    console.error("getPurchaseReceiptById error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.createPurchaseReceipt = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const { id } = req.params;
    const purchase = await getPurchaseOr404({ company_id, purchase_id: id, factoryFilter: factoryWhere(req) });
    if (["CANCELLED", "CLOSED"].includes(purchase.status)) {
      return res.status(400).json({ message: "Cannot receive against cancelled/closed purchase" });
    }

    const body = req.body || {};
    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (!rawItems.length) return res.status(400).json({ message: "items must be a non-empty array" });

    const created = await prisma.$transaction(async (tx) => {
      const receiptDate = parseDateOrNull(body.receipt_date) || new Date();
      const receipt_no = body.receipt_no ? String(body.receipt_no).trim() : await makePurchaseReceiptNoTx(tx, company_id, receiptDate);

      const dbPurchase = await tx.purchase.findUnique({ where: { id }, include: { items: true } });
      const purchaseItemsById = new Map(dbPurchase.items.map((item) => [item.id, item]));

      const normalizedItems = rawItems.map((row) => {
        const purchase_item_id = row.purchase_item_id ? String(row.purchase_item_id).trim() : null;
        const purchaseItem = purchase_item_id ? purchaseItemsById.get(purchase_item_id) : null;
        if (!purchaseItem) {
          const err = new Error(`Purchase item not found: ${purchase_item_id || "unknown"}`);
          err.statusCode = 404;
          throw err;
        }
        const quantity = round2(toNumber(row.quantity));
        const accepted_quantity = row.accepted_quantity !== undefined ? round2(toNumber(row.accepted_quantity)) : quantity;
        const rejected_quantity = row.rejected_quantity !== undefined ? round2(toNumber(row.rejected_quantity)) : round2(quantity - accepted_quantity);
        if (quantity <= 0) {
          const err = new Error("Receipt quantity must be > 0");
          err.statusCode = 400;
          throw err;
        }
        if (accepted_quantity < 0 || rejected_quantity < 0) {
          const err = new Error("accepted/rejected quantities cannot be negative");
          err.statusCode = 400;
          throw err;
        }
        if (round2(accepted_quantity + rejected_quantity) !== quantity) {
          const err = new Error("accepted_quantity + rejected_quantity must equal quantity");
          err.statusCode = 400;
          throw err;
        }
        const pendingQty = round2(toNumber(purchaseItem.quantity) - toNumber(purchaseItem.received_quantity));
        if (quantity - pendingQty > 0.000001) {
          const err = new Error(`Receive quantity exceeds pending quantity for ${purchaseItem.description}`);
          err.statusCode = 400;
          throw err;
        }
        return {
          purchaseItem,
          quantity,
          accepted_quantity,
          rejected_quantity,
          location_label: cleanNullableText(row.location_label),
          notes: cleanNullableText(row.notes),
          tracked_lines: Array.isArray(row.tracked_lines) ? row.tracked_lines : []
        };
      });

      const receipt = await tx.purchaseReceipt.create({
        data: {
          company_id,
          factory_id: purchase.factory_id,
          purchase_id: purchase.id,
          receipt_no,
          receipt_date: receiptDate,
          status: normalizeReceiptStatus(body.status, "POSTED") || "POSTED",
          notes: cleanNullableText(body.notes),
          created_by: req.user.id
        }
      });

      for (const row of normalizedItems) {
        let movement = null;
        if (row.accepted_quantity > 0 && row.purchaseItem.product_id) {
          const createdMovement = await createMovementTx(tx, {
            company_id,
            factory_id: purchase.factory_id,
            product_id: row.purchaseItem.product_id,
            type: "IN",
            source_type: "MANUAL",
            source_id: receipt.id,
            date: receipt.receipt_date,
            quantity: row.accepted_quantity,
            unit_cost: row.purchaseItem.unit_price,
            remarks: `GRN ${receipt.receipt_no}${row.location_label ? ` @ ${row.location_label}` : ""}`,
            created_by: req.user.id
          }, { tracked_lines: row.tracked_lines || [] });
          movement = createdMovement.movement;
        }

        await tx.purchaseReceiptItem.create({
          data: {
            company_id,
            purchase_receipt_id: receipt.id,
            purchase_item_id: row.purchaseItem.id,
            product_id: row.purchaseItem.product_id,
            inventory_movement_id: movement?.id || null,
            description: row.purchaseItem.description,
            ordered_quantity: row.purchaseItem.quantity,
            quantity: row.quantity,
            accepted_quantity: row.accepted_quantity,
            rejected_quantity: row.rejected_quantity,
            unit_cost: row.purchaseItem.unit_price,
            location_label: row.location_label,
            notes: row.notes
          }
        });

        await tx.purchaseItem.update({
          where: { id: row.purchaseItem.id },
          data: { received_quantity: { increment: row.quantity } }
        });
      }

      const freshItems = await tx.purchaseItem.findMany({ where: { purchase_id: purchase.id, company_id } });
      const nextStatus = derivePurchaseLifecycleStatus(freshItems, purchase.status);
      await tx.purchase.update({ where: { id: purchase.id }, data: { status: nextStatus } });
      await tx.purchaseStatusHistory.create({
        data: {
          company_id,
          purchase_id: purchase.id,
          status: nextStatus,
          note: `GRN ${receipt.receipt_no} posted`,
          created_by: req.user.id
        }
      });

      return tx.purchaseReceipt.findUnique({
        where: { id: receipt.id },
        include: { purchase: true, items: { include: { product: true, purchase_item: true } } }
      });
    });

    await logActivity({ company_id, factory_id: purchase.factory_id, user_id: req.user.id, action: "PURCHASE_RECEIPT_CREATED", entity_type: "purchase_receipt", entity_id: created.id });
    return res.status(201).json(created);
  } catch (err) {
    console.error("createPurchaseReceipt error:", err);
    return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
  }
};

exports.getSupplierReturns = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const fw = factoryWhere(req);
    const purchase_id = req.params.id;
    const where = { company_id, ...(purchase_id ? { purchase_id } : {}), ...(fw.factory_id ? { factory_id: fw.factory_id } : {}) };
    const rows = await prisma.supplierReturn.findMany({
      where,
      orderBy: [{ return_date: "desc" }, { id: "desc" }],
      include: { purchase: { select: { id: true, purchase_no: true, vendor_name: true } }, items: { include: { product: true, purchase_item: true } } }
    });
    return res.json({ count: rows.length, rows });
  } catch (err) {
    console.error("getSupplierReturns error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getSupplierReturnById = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const fw = factoryWhere(req);
    const { returnId } = req.params;
    const row = await prisma.supplierReturn.findFirst({
      where: { id: returnId, company_id, ...(fw.factory_id ? { factory_id: fw.factory_id } : {}) },
      include: {
        purchase: { include: { items: true, charges: true } },
        items: { include: { product: true, purchase_item: true } }
      }
    });
    if (!row) return res.status(404).json({ message: "Supplier return not found" });
    return res.json(row);
  } catch (err) {
    console.error("getSupplierReturnById error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.createSupplierReturn = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const { id } = req.params;
    const purchase = await getPurchaseOr404({ company_id, purchase_id: id, factoryFilter: factoryWhere(req) });
    const body = req.body || {};
    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (!rawItems.length) return res.status(400).json({ message: "items must be a non-empty array" });

    const created = await prisma.$transaction(async (tx) => {
      const returnDate = parseDateOrNull(body.return_date) || new Date();
      const return_no = body.return_no ? String(body.return_no).trim() : await makeSupplierReturnNoTx(tx, company_id, returnDate);
      const dbPurchase = await tx.purchase.findUnique({ where: { id }, include: { items: true } });
      const purchaseItemsById = new Map(dbPurchase.items.map((item) => [item.id, item]));

      const normalizedItems = rawItems.map((row) => {
        const purchase_item_id = row.purchase_item_id ? String(row.purchase_item_id).trim() : null;
        const purchaseItem = purchase_item_id ? purchaseItemsById.get(purchase_item_id) : null;
        if (!purchaseItem) {
          const err = new Error(`Purchase item not found: ${purchase_item_id || "unknown"}`);
          err.statusCode = 404;
          throw err;
        }
        const quantity = round2(toNumber(row.quantity));
        if (quantity <= 0) {
          const err = new Error("Return quantity must be > 0");
          err.statusCode = 400;
          throw err;
        }
        const maxReturnable = round2(toNumber(purchaseItem.received_quantity) - toNumber(purchaseItem.returned_quantity));
        if (quantity - maxReturnable > 0.000001) {
          const err = new Error(`Return quantity exceeds returnable stock for ${purchaseItem.description}`);
          err.statusCode = 400;
          throw err;
        }
        return {
          purchaseItem,
          quantity,
          unit_price: row.unit_price !== undefined ? toNumber(row.unit_price) : toNumber(purchaseItem.unit_price),
          reason_code: cleanNullableText(row.reason_code),
          reason_note: cleanNullableText(row.reason_note),
          location_label: cleanNullableText(row.location_label),
          tracked_lines: Array.isArray(row.tracked_lines) ? row.tracked_lines : []
        };
      });

      const supplierReturn = await tx.supplierReturn.create({
        data: {
          company_id,
          factory_id: purchase.factory_id,
          purchase_id: purchase.id,
          return_no,
          debit_note_no: cleanNullableText(body.debit_note_no),
          return_date: returnDate,
          status: normalizeReturnStatus(body.status, "COMPLETED") || "COMPLETED",
          reason_summary: cleanNullableText(body.reason_summary),
          notes: cleanNullableText(body.notes),
          created_by: req.user.id
        }
      });

      for (const row of normalizedItems) {
        let movement = null;
        if (row.purchaseItem.product_id) {
          const createdMovement = await createMovementTx(tx, {
            company_id,
            factory_id: purchase.factory_id,
            product_id: row.purchaseItem.product_id,
            type: "OUT",
            source_type: "RETURN",
            source_id: supplierReturn.id,
            date: supplierReturn.return_date,
            quantity: row.quantity,
            unit_cost: row.unit_price,
            remarks: `Supplier Return ${supplierReturn.return_no}${row.location_label ? ` @ ${row.location_label}` : ""}`,
            created_by: req.user.id
          }, { tracked_lines: row.tracked_lines || [] });
          movement = createdMovement.movement;
        }

        await tx.supplierReturnItem.create({
          data: {
            company_id,
            supplier_return_id: supplierReturn.id,
            purchase_item_id: row.purchaseItem.id,
            product_id: row.purchaseItem.product_id,
            inventory_movement_id: movement?.id || null,
            description: row.purchaseItem.description,
            quantity: row.quantity,
            unit_price: row.unit_price,
            reason_code: row.reason_code,
            reason_note: row.reason_note,
            location_label: row.location_label
          }
        });

        await tx.purchaseItem.update({
          where: { id: row.purchaseItem.id },
          data: { returned_quantity: { increment: row.quantity } }
        });
      }

      return tx.supplierReturn.findUnique({
        where: { id: supplierReturn.id },
        include: { purchase: true, items: { include: { product: true, purchase_item: true } } }
      });
    });

    await logActivity({ company_id, factory_id: purchase.factory_id, user_id: req.user.id, action: "SUPPLIER_RETURN_CREATED", entity_type: "supplier_return", entity_id: created.id });
    return res.status(201).json(created);
  } catch (err) {
    console.error("createSupplierReturn error:", err);
    return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
  }
};

exports.getPendingPurchaseReceiveReport = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const fw = factoryWhere(req);
    const rows = await prisma.purchase.findMany({
      where: {
        company_id,
        ...fw,
        is_active: true,
        status: { in: ["ORDERED", "PARTIALLY_RECEIVED", "DRAFT"] }
      },
      orderBy: [{ purchase_date: "desc" }, { id: "desc" }],
      include: {
        factory: { select: { id: true, name: true } },
        items: { include: { product: { select: { id: true, name: true, sku: true, unit: true } } } }
      }
    });

    const report = rows.map((purchase) => ({
      id: purchase.id,
      purchase_no: purchase.purchase_no,
      purchase_date: purchase.purchase_date,
      vendor_name: purchase.vendor_name,
      status: purchase.status,
      factory: purchase.factory,
      pending_items: purchase.items
        .map((item) => ({
          purchase_item_id: item.id,
          product_id: item.product_id,
          product_name: item.product?.name || item.description,
          ordered_quantity: item.quantity,
          received_quantity: item.received_quantity,
          pending_quantity: round2(Math.max(0, toNumber(item.quantity) - toNumber(item.received_quantity))),
          unit: item.unit || item.product?.unit || null
        }))
        .filter((item) => item.pending_quantity > 0)
    })).filter((row) => row.pending_items.length > 0);

    return res.json({ count: report.length, rows: report });
  } catch (err) {
    console.error("getPendingPurchaseReceiveReport error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getSupplierPerformanceReport = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const fw = factoryWhere(req);
    const purchases = await prisma.purchase.findMany({
      where: { company_id, ...fw, is_active: true },
      include: { items: true, returns: { include: { items: true } } },
      orderBy: [{ purchase_date: "desc" }]
    });

    const map = new Map();
    for (const purchase of purchases) {
      const key = `${purchase.vendor_name}||${purchase.vendor_gstin || ""}`;
      const row = map.get(key) || {
        vendor_name: purchase.vendor_name,
        vendor_gstin: purchase.vendor_gstin,
        purchase_count: 0,
        ordered_qty: 0,
        received_qty: 0,
        returned_qty: 0,
        total_value: 0,
        fully_received_count: 0,
        partially_received_count: 0
      };
      row.purchase_count += 1;
      row.ordered_qty = round2(row.ordered_qty + purchase.items.reduce((sum, item) => sum + toNumber(item.quantity), 0));
      row.received_qty = round2(row.received_qty + purchase.items.reduce((sum, item) => sum + toNumber(item.received_quantity), 0));
      row.returned_qty = round2(row.returned_qty + purchase.returns.reduce((sum, ret) => sum + ret.items.reduce((s, item) => s + toNumber(item.quantity), 0), 0));
      row.total_value = round2(row.total_value + toNumber(purchase.total));
      if (purchase.status === "RECEIVED") row.fully_received_count += 1;
      if (purchase.status === "PARTIALLY_RECEIVED") row.partially_received_count += 1;
      map.set(key, row);
    }

    const rows = [...map.values()].map((row) => ({
      ...row,
      fill_rate_pct: row.ordered_qty > 0 ? round2((row.received_qty / row.ordered_qty) * 100) : 0,
      return_rate_pct: row.received_qty > 0 ? round2((row.returned_qty / row.received_qty) * 100) : 0
    })).sort((a, b) => b.total_value - a.total_value);

    return res.json({ count: rows.length, rows });
  } catch (err) {
    console.error("getSupplierPerformanceReport error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getPurchaseVarianceReport = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const fw = factoryWhere(req);
    const purchases = await prisma.purchase.findMany({
      where: { company_id, ...fw, is_active: true },
      include: { factory: { select: { id: true, name: true } }, items: { include: { product: { select: { id: true, name: true, sku: true, unit: true } } } } },
      orderBy: [{ purchase_date: "desc" }, { id: "desc" }]
    });

    const rows = [];
    for (const purchase of purchases) {
      for (const item of purchase.items) {
        rows.push({
          purchase_id: purchase.id,
          purchase_no: purchase.purchase_no,
          purchase_date: purchase.purchase_date,
          vendor_name: purchase.vendor_name,
          factory: purchase.factory,
          purchase_item_id: item.id,
          product_id: item.product_id,
          product_name: item.product?.name || item.description,
          sku: item.product?.sku || null,
          unit: item.unit || item.product?.unit || null,
          ordered_quantity: item.quantity,
          received_quantity: item.received_quantity,
          returned_quantity: item.returned_quantity,
          variance_quantity: round2(toNumber(item.received_quantity) - toNumber(item.quantity)),
          pending_quantity: round2(Math.max(0, toNumber(item.quantity) - toNumber(item.received_quantity))),
          line_total: item.line_total
        });
      }
    }

    return res.json({ count: rows.length, rows });
  } catch (err) {
    console.error("getPurchaseVarianceReport error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getPurchasePdf = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const fw = factoryWhere(req);
    const { id } = req.params;

    const po = await prisma.purchase.findFirst({
      where: { id, company_id, ...fw, is_active: true },
      select: { id: true, factory_id: true, updated_at: true }
    });
    if (!po) return res.status(404).json({ message: "Purchase not found" });

    const factory_id = po.factory_id;

    const outPath = buildTempPdfPath("purchase", company_id, factory_id, id);
    await generatePurchasePdfToFile({ company_id, factory_id, purchaseId: id, outPath });

    return streamPdfAndDelete({
      res,
      filePath: outPath,
      filename: `purchase-${id}.pdf`,
      inline: true
    });
  } catch (err) {
    console.error("getPurchasePdf error:", err);
    return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
  }
};
