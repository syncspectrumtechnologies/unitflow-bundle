const prisma = require("../config/db");
const logActivity = require("../utils/activityLogger");
const fs = require("fs");
const { buildTempPdfPath } = require("../utils/fileStorage");
const { streamPdfAndDelete } = require("../utils/pdfResponse");
const { generatePurchasePdfToFile } = require("../services/pdf/purchasePdf");
const { factoryWhere, requireSingleFactory } = require("../utils/factoryScope");
const { getPagination, buildPaginationMeta } = require("../utils/pagination");

function parseDateOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toNumber(v) {
  const n = typeof v === "string" ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function sumCharges(charges = []) {
  return charges.reduce((acc, c) => acc + toNumber(c.amount || 0), 0);
}

function calcLineTotal(qty, unit_price, discount) {
  const q = toNumber(qty);
  const p = toNumber(unit_price);
  const d = toNumber(discount);
  return q * p - d;
}

// Items can come from DB (PurchaseItem) or request payload.
// Support both shapes safely.
function calcItemsSubtotal(items = []) {
  if (!Array.isArray(items) || items.length === 0) return 0;
  return items.reduce((acc, it) => {
    // Prefer explicit line_total if present
    const lt = it?.line_total;
    if (lt !== undefined && lt !== null) return acc + toNumber(lt);

    // Support both shapes:
    // - DB shape: qty, unit_price, discount
    // - request shape: quantity, unit_price, discount
    const qty = toNumber(it?.qty ?? it?.quantity ?? 0);
    const unitPrice = toNumber(it?.unit_price || 0);
    const discount = toNumber(it?.discount || 0);
    return acc + (qty * unitPrice - discount);
  }, 0);
}

exports.getPurchases = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const fw = factoryWhere(req);

    const q = (req.query.q || "").toString().trim();
    const status = (req.query.status || "").toString().trim();
    const date_from = parseDateOrNull(req.query.date_from);
    const date_to = parseDateOrNull(req.query.date_to);

    const where = { company_id, ...fw, is_active: true };
    if (q) {
      where.OR = [
        { purchase_no: { contains: q, mode: "insensitive" } },
        { vendor_name: { contains: q, mode: "insensitive" } },
        { vendor_phone: { contains: q, mode: "insensitive" } },
        { vendor_email: { contains: q, mode: "insensitive" } }
      ];
    }
    if (status) where.status = status;
    if (date_from || date_to) {
      where.purchase_date = { ...(date_from ? { gte: date_from } : {}), ...(date_to ? { lte: date_to } : {}) };
    }

    const pagination = getPagination(req, { defaultPageSize: 25, maxPageSize: 100 });
    const query = {
      where,
      orderBy: [{ updated_at: "desc" }, { id: "desc" }],
      include: {
        factory: { select: { id: true, name: true } },
        _count: { select: { items: true, charges: true } }
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

    if (!pagination.enabled) return res.json({ count: rows.length, rows });

    return res.json({
      count: total ?? rows.length,
      rows,
      pagination: buildPaginationMeta({ page: pagination.page, page_size: pagination.page_size, total: total ?? rows.length })
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

    const purchase = await prisma.purchase.findFirst({
      where: { id, company_id, ...fw, is_active: true },
      include: { items: true, charges: true, timeline: { orderBy: { created_at: "asc" } } }
    });

    if (!purchase) return res.status(404).json({ message: "Purchase not found" });
    return res.json(purchase);
  } catch (err) {
    console.error("getPurchaseById error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.createPurchase = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const factory_id = requireSingleFactory(req);

    const {
      purchase_no,
      purchase_date,
      vendor_name,
      vendor_gstin,
      vendor_phone,
      vendor_email,
      vendor_address,
      notes,
      items = [],
      charges = []
    } = req.body || {};

    if (!purchase_no) return res.status(400).json({ message: "purchase_no is required" });
    if (!vendor_name) return res.status(400).json({ message: "vendor_name is required" });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ message: "items must be a non-empty array" });

    const computedItems = items.map((it) => {
      const qty = toNumber(it.quantity);
      const rate = toNumber(it.unit_price);
      return {
        description: String(it.description || "").trim(),
        quantity: qty,
        unit_price: rate,
        line_total: qty * rate
      };
    });

    const subtotal = computedItems.reduce((a, b) => a + toNumber(b.line_total), 0);
    const chargeTotal = sumCharges(charges);
    const total = subtotal + chargeTotal;

    const created = await prisma.$transaction(async (tx) => {
      const po = await tx.purchase.create({
        data: {
          company_id,
          factory_id,
          purchase_no: String(purchase_no).trim(),
          purchase_date: purchase_date ? new Date(purchase_date) : new Date(),
          vendor_name: String(vendor_name).trim(),
          vendor_gstin: vendor_gstin?.toString().trim() || null,
          vendor_phone: vendor_phone?.toString().trim() || null,
          vendor_email: vendor_email?.toString().trim() || null,
          vendor_address: vendor_address?.toString().trim() || null,
          notes: notes?.toString() || null,
          subtotal,
          total,
          created_by: req.user.id,
          is_active: true,
          status: "DRAFT"
        }
      });

      await tx.purchaseItem.createMany({
        data: computedItems.map((it) => ({ company_id, purchase_id: po.id, ...it }))
      });

      if (Array.isArray(charges) && charges.length) {
        await tx.purchaseCharge.createMany({
          data: charges.map((c) => ({
            company_id,
            purchase_id: po.id,
            label: String(c.label || "Charge").trim(),
            amount: toNumber(c.amount)
          }))
        });
      }

      await tx.purchaseStatusHistory.create({
        data: {
          company_id,
          purchase_id: po.id,
          status: "DRAFT",
          note: "Created",
          created_by: req.user.id
        }
      });

      return po;
    });

    await logActivity({
      company_id,
      factory_id,
      user_id: req.user.id,
      action: "PURCHASE_CREATED",
      entity_type: "purchase",
      entity_id: created.id
    });

    return res.status(201).json(created);
  } catch (err) {
    console.error("createPurchase error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.updatePurchase = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const factory_id = requireSingleFactory(req);
    const { id } = req.params;

    const existing = await prisma.purchase.findFirst({
      where: { id, company_id, factory_id, is_active: true },
      include: { items: true, charges: true }
    });
    if (!existing) return res.status(404).json({ message: "Purchase not found" });

    // For safety, only allow updates while in DRAFT
    if (existing.status !== "DRAFT") {
      return res.status(400).json({ message: "Only DRAFT purchases can be edited" });
    }

    const { vendor_name, vendor_phone, vendor_gstin, purchase_date, notes, items, charges } = req.body || {};

    // If items/charges are provided, validate them; otherwise keep existing
    const itemsToUse = items === undefined ? existing.items : items;
    const chargesToUse = charges === undefined ? existing.charges : charges;

    if (items !== undefined) {
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: "items must be a non-empty array" });
      }
    }

    if (charges !== undefined && !Array.isArray(charges)) {
      return res.status(400).json({ message: "charges must be an array" });
    }

    const subtotal = calcItemsSubtotal(itemsToUse);

    // NOTE: Purchase model does NOT have `total_charges` column in Prisma schema.
    // We compute it only to derive `total`.
    const computedChargesTotal = sumCharges(chargesToUse);
    const total = subtotal + computedChargesTotal;

    const updated = await prisma.$transaction(async (tx) => {
      const pu = await tx.purchase.update({
        where: { id },
        data: {
          vendor_name: vendor_name !== undefined ? String(vendor_name).trim() : existing.vendor_name,
          vendor_phone: vendor_phone !== undefined ? String(vendor_phone).trim() : existing.vendor_phone,
          vendor_gstin: vendor_gstin !== undefined ? (vendor_gstin ? String(vendor_gstin).trim() : null) : existing.vendor_gstin,
          purchase_date: purchase_date ? new Date(purchase_date) : existing.purchase_date,
          notes: notes !== undefined ? (notes ? String(notes) : null) : existing.notes,
          subtotal,
          total
        }
      });

      if (items !== undefined) {
        await tx.purchaseItem.deleteMany({ where: { purchase_id: id, company_id, factory_id } });

        // Support both request shapes:
        // A) { item_name, qty, unit_price, discount, unit }
        // B) { description, quantity, unit_price, discount }
        await tx.purchaseItem.createMany({
          data: items.map((it) => {
            const itemName = String(it.item_name ?? it.description ?? "").trim();
            const qty = toNumber(it.qty ?? it.quantity ?? 0);
            const unitPrice = toNumber(it.unit_price ?? 0);
            const discount = toNumber(it.discount ?? 0);

            return {
              company_id,
              factory_id,
              purchase_id: id,
              item_name: itemName,
              qty,
              unit: it.unit ? String(it.unit) : null,
              unit_price: unitPrice,
              discount,
              line_total: calcLineTotal(qty, unitPrice, discount)
            };
          })
        });
      }

      if (charges !== undefined) {
        await tx.purchaseCharge.deleteMany({ where: { purchase_id: id, company_id, factory_id } });
        if (charges.length > 0) {
          await tx.purchaseCharge.createMany({
            data: charges.map((c) => ({
              company_id,
              factory_id,
              purchase_id: id,
              label: String(c.label || "").trim(),
              amount: toNumber(c.amount || 0)
            }))
          });
        }
      }

      return tx.purchase.findUnique({
        where: { id },
        include: { items: true, charges: true }
      });
    });

    return res.json(updated);
  } catch (err) {
    console.error("updatePurchase error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.updatePurchaseStatus = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const factory_id = requireSingleFactory(req);
    const { id } = req.params;
    const { status, note } = req.body || {};

    if (!status) return res.status(400).json({ message: "status is required" });

    const existing = await prisma.purchase.findFirst({ where: { id, company_id, factory_id, is_active: true } });
    if (!existing) return res.status(404).json({ message: "Purchase not found" });

    const updated = await prisma.$transaction(async (tx) => {
      const po = await tx.purchase.update({ where: { id }, data: { status } });
      await tx.purchaseStatusHistory.create({
        data: { company_id, purchase_id: id, status, note: note?.toString() || null, created_by: req.user.id }
      });
      return po;
    });

    return res.json(updated);
  } catch (err) {
    console.error("updatePurchaseStatus error:", err);
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
