const prisma = require("../config/db");
const logActivity = require("../utils/activityLogger");
const { requireSingleFactory, factoryWhere } = require("../utils/factoryScope");
const { resolveSalesGstContextTx } = require("../services/documentTaxService");
const { makeDeliveryChallanNoTx } = require("../utils/numbering");
const { buildTempPdfPath } = require("../utils/fileStorage");
const { streamPdfAndDelete } = require("../utils/pdfResponse");
const { generateDeliveryChallanPdfToFile } = require("../services/pdf/deliveryChallanPdf");

function parseDateOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeStatus(value, fallback = null) {
  const raw = String(value || fallback || "").trim().toUpperCase();
  const allowed = new Set(["DRAFT", "ISSUED", "CLOSED", "CANCELLED"]);
  return allowed.has(raw) ? raw : fallback;
}

function cleanText(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function includeShape() {
  return {
    factory: { select: { id: true, name: true, state: true, state_code: true } },
    client: { select: { id: true, company_name: true, gstin: true, state: true, state_code: true, address: true, phone: true } },
    order: { select: { id: true, order_no: true, status: true } },
    sales_company: { select: { id: true, name: true, legal_name: true, gstin: true, address: true, phone: true, email: true, state: true, state_code: true } },
    items: {
      include: {
        product: { select: { id: true, name: true, sku: true, unit: true, hsn_sac_code: true } }
      },
      orderBy: { created_at: "asc" }
    }
  };
}

exports.getDeliveryChallans = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const fw = factoryWhere(req);

    const rows = await prisma.deliveryChallan.findMany({
      where: { company_id, ...fw, is_active: true },
      orderBy: [{ issue_date: "desc" }, { id: "desc" }],
      include: includeShape()
    });

    return res.json({ count: rows.length, rows });
  } catch (err) {
    console.error("getDeliveryChallans error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getDeliveryChallanById = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const fw = factoryWhere(req);

    const row = await prisma.deliveryChallan.findFirst({
      where: { id: req.params.id, company_id, ...fw, is_active: true },
      include: includeShape()
    });

    if (!row) return res.status(404).json({ message: "Delivery challan not found" });
    return res.json(row);
  } catch (err) {
    console.error("getDeliveryChallanById error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.createDeliveryChallan = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const factory_id = requireSingleFactory(req);
    const body = req.body || {};

    if (!Array.isArray(body.items) || body.items.length === 0) {
      return res.status(400).json({ message: "items must be a non-empty array" });
    }

    const normalizedItems = body.items.map((row) => {
      const qty = Number(row.quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        const err = new Error("Each item quantity must be > 0");
        err.statusCode = 400;
        throw err;
      }
      return { ...row, quantity: qty };
    });

    const createdBase = await prisma.$transaction(
      async (tx) => {
        const issue_date = parseDateOrNull(body.issue_date) || new Date();
        const challan_no = body.challan_no
          ? String(body.challan_no).trim()
          : await makeDeliveryChallanNoTx(tx, company_id, issue_date);

        const gstContext = await resolveSalesGstContextTx(tx, {
          company_id,
          sales_company_id: body.sales_company_id,
          client_id: body.client_id
        });

        if (body.order_id) {
          const order = await tx.order.findFirst({
            where: { id: body.order_id, company_id, factory_id, is_active: true }
          });
          if (!order) {
            const err = new Error("Order not found");
            err.statusCode = 404;
            throw err;
          }
        }

        const productIds = [...new Set(normalizedItems.map((row) => row.product_id).filter(Boolean))];
        const products = await tx.product.findMany({
          where: { company_id, id: { in: productIds }, is_active: true }
        });
        const byId = new Map(products.map((row) => [row.id, row]));

        if (byId.size !== productIds.length) {
          const err = new Error("One or more products not found");
          err.statusCode = 404;
          throw err;
        }

        const challan = await tx.deliveryChallan.create({
          data: {
            company_id,
            factory_id,
            client_id: body.client_id || null,
            order_id: body.order_id || null,
            sales_company_id: body.sales_company_id || null,
            challan_no,
            kind: body.kind ? String(body.kind).trim().toUpperCase() : "OUTWARD",
            reason: body.reason ? String(body.reason).trim().toUpperCase() : "SALE",
            status: normalizeStatus(body.status, "ISSUED") || "ISSUED",
            issue_date,
            place_of_supply_state: body.place_of_supply_state || gstContext.place_of_supply_state || null,
            place_of_supply_code: body.place_of_supply_code || gstContext.place_of_supply_code || null,
            notes: cleanText(body.notes),
            created_by: req.user.id,
            is_active: true
          }
        });

        await tx.deliveryChallanItem.createMany({
          data: normalizedItems.map((row) => {
            const product = byId.get(row.product_id);
            return {
              company_id,
              delivery_challan_id: challan.id,
              product_id: product.id,
              quantity: Number(row.quantity),
              remarks: cleanText(row.remarks)
            };
          })
        });

        return { id: challan.id, factory_id: challan.factory_id };
      },
      {
        maxWait: 10000,
        timeout: 20000
      }
    );

    const created = await prisma.deliveryChallan.findUnique({
      where: { id: createdBase.id },
      include: includeShape()
    });

    await logActivity({
      company_id,
      factory_id,
      user_id: req.user.id,
      action: "DELIVERY_CHALLAN_CREATED",
      entity_type: "delivery_challan",
      entity_id: created.id
    });

    return res.status(201).json(created);
  } catch (err) {
    console.error("createDeliveryChallan error:", err);
    return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
  }
};

exports.updateDeliveryChallan = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const fw = factoryWhere(req);
    const { id } = req.params;
    const body = req.body || {};

    const existing = await prisma.deliveryChallan.findFirst({
      where: { id, company_id, ...fw, is_active: true },
      include: includeShape()
    });

    if (!existing) return res.status(404).json({ message: "Delivery challan not found" });
    if (!["DRAFT", "ISSUED"].includes(existing.status)) {
      return res.status(400).json({ message: "Only draft/issued challans can be edited" });
    }

    const updatedBase = await prisma.$transaction(
      async (tx) => {
        await tx.deliveryChallan.update({
          where: { id },
          data: {
            client_id: body.client_id !== undefined ? body.client_id || null : existing.client_id,
            order_id: body.order_id !== undefined ? body.order_id || null : existing.order_id,
            sales_company_id: body.sales_company_id !== undefined ? body.sales_company_id || null : existing.sales_company_id,
            kind: body.kind ? String(body.kind).trim().toUpperCase() : existing.kind,
            reason: body.reason ? String(body.reason).trim().toUpperCase() : existing.reason,
            status: body.status ? normalizeStatus(body.status, existing.status) : existing.status,
            issue_date: parseDateOrNull(body.issue_date) || existing.issue_date,
            place_of_supply_state:
              body.place_of_supply_state !== undefined ? body.place_of_supply_state || null : existing.place_of_supply_state,
            place_of_supply_code:
              body.place_of_supply_code !== undefined ? body.place_of_supply_code || null : existing.place_of_supply_code,
            notes: body.notes !== undefined ? cleanText(body.notes) : existing.notes
          }
        });

        if (body.items !== undefined) {
          if (!Array.isArray(body.items) || !body.items.length) {
            const err = new Error("items must be a non-empty array");
            err.statusCode = 400;
            throw err;
          }

          const normalizedItems = body.items.map((row) => {
            const qty = Number(row.quantity);
            if (!Number.isFinite(qty) || qty <= 0) {
              const err = new Error("Each item quantity must be > 0");
              err.statusCode = 400;
              throw err;
            }
            return { ...row, quantity: qty };
          });

          const productIds = [...new Set(normalizedItems.map((row) => row.product_id).filter(Boolean))];
          const products = await tx.product.findMany({
            where: { company_id, id: { in: productIds }, is_active: true }
          });
          const byId = new Map(products.map((row) => [row.id, row]));

          if (byId.size !== productIds.length) {
            const err = new Error("One or more products not found");
            err.statusCode = 404;
            throw err;
          }

          await tx.deliveryChallanItem.deleteMany({
            where: { delivery_challan_id: id, company_id }
          });

          await tx.deliveryChallanItem.createMany({
            data: normalizedItems.map((row) => ({
              company_id,
              delivery_challan_id: id,
              product_id: byId.get(row.product_id).id,
              quantity: Number(row.quantity),
              remarks: cleanText(row.remarks)
            }))
          });
        }

        return { id };
      },
      {
        maxWait: 10000,
        timeout: 20000
      }
    );

    const updated = await prisma.deliveryChallan.findUnique({
      where: { id: updatedBase.id },
      include: includeShape()
    });

    await logActivity({
      company_id,
      factory_id: existing.factory_id,
      user_id: req.user.id,
      action: "DELIVERY_CHALLAN_UPDATED",
      entity_type: "delivery_challan",
      entity_id: id
    });

    return res.json(updated);
  } catch (err) {
    console.error("updateDeliveryChallan error:", err);
    return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
  }
};

exports.updateDeliveryChallanStatus = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const fw = factoryWhere(req);
    const { id } = req.params;

    const existing = await prisma.deliveryChallan.findFirst({
      where: { id, company_id, ...fw, is_active: true }
    });

    if (!existing) return res.status(404).json({ message: "Delivery challan not found" });

    const status = normalizeStatus(req.body?.status);
    if (!status) return res.status(400).json({ message: "Invalid status" });

    const updated = await prisma.deliveryChallan.update({
      where: { id },
      data: { status }
    });

    return res.json(updated);
  } catch (err) {
    console.error("updateDeliveryChallanStatus error:", err);
    return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
  }
};

exports.getDeliveryChallanPdf = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const fw = factoryWhere(req);
    const { id } = req.params;

    const row = await prisma.deliveryChallan.findFirst({
      where: { id, company_id, ...fw, is_active: true },
      select: { id: true, factory_id: true }
    });

    if (!row) return res.status(404).json({ message: "Delivery challan not found" });

    const outPath = buildTempPdfPath("delivery-challan", company_id, row.factory_id, id);
    await generateDeliveryChallanPdfToFile({
      company_id,
      factory_id: row.factory_id,
      challanId: id,
      outPath
    });

    return streamPdfAndDelete({
      res,
      filePath: outPath,
      filename: `delivery-challan-${id}.pdf`,
      inline: true
    });
  } catch (err) {
    console.error("getDeliveryChallanPdf error:", err);
    return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
  }
};