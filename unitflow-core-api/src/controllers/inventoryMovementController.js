const prisma = require("../config/db");
const logActivity = require("../utils/activityLogger");
const stockService = require("../services/stockService");
const { createMovementTx } = require("../services/inventoryLedgerService");
const { getTrackedStockView } = require("../services/trackedInventoryService");
const { buildTempPdfPath } = require("../utils/fileStorage");
const { streamPdfAndDelete } = require("../utils/pdfResponse");
const { generateProductBarcodeLabelsToFile } = require("../services/pdf/barcodeLabelPdf");
const { getPagination, buildPaginationMeta } = require("../utils/pagination");
const { factoryWhere, requireSingleFactory } = require("../utils/factoryScope");

const TX_OPTS = {
  maxWait: 10000,
  timeout: 30000
};

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

    const { product_id, quantity, date, remarks, unit_cost, tracked_lines } = req.body;

    if (!product_id) {
      return res.status(400).json({ message: "product_id is required" });
    }

    const qty = validateQtyPositive(quantity);
    if (!qty) {
      return res.status(400).json({ message: "quantity must be a number > 0" });
    }

    const movementDate = parseDateOrNull(date) || new Date();

    const product = await prisma.product.findFirst({
      where: { id: product_id, company_id, is_active: true },
      select: { id: true }
    });

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    const { movement } = await prisma.$transaction(
      (tx) =>
        createMovementTx(
          tx,
          {
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
          },
          { tracked_lines }
        ),
      TX_OPTS
    );

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
    return res.status(err?.statusCode || 500).json({
      message: err?.message || "Internal server error",
      ...(err?.meta ? err.meta : {})
    });
  }
};

exports.createOut = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const factory_id = requireSingleFactory(req);

    const { product_id, quantity, date, remarks, tracked_lines } = req.body;

    if (!product_id) {
      return res.status(400).json({ message: "product_id is required" });
    }

    const qty = validateQtyPositive(quantity);
    if (!qty) {
      return res.status(400).json({ message: "quantity must be a number > 0" });
    }

    const movementDate = parseDateOrNull(date) || new Date();

    const product = await prisma.product.findFirst({
      where: { id: product_id, company_id, is_active: true },
      select: { id: true }
    });

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    let movement;
    try {
      ({ movement } = await prisma.$transaction(
        (tx) =>
          createMovementTx(
            tx,
            {
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
            },
            { tracked_lines }
          ),
        TX_OPTS
      ));
    } catch (err) {
      if (
        err?.message === "INSUFFICIENT_STOCK" ||
        err?.message === "INSUFFICIENT_TRACKED_STOCK" ||
        err?.message === "SERIAL_NOT_AVAILABLE"
      ) {
        return res.status(err.statusCode || 400).json({
          message: err.message,
          ...(err.meta || {})
        });
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
    return res.status(err?.statusCode || 500).json({
      message: err?.message || "Internal server error",
      ...(err?.meta ? err.meta : {})
    });
  }
};

exports.createAdjustment = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const factory_id = requireSingleFactory(req);

    const { product_id, quantity, date, remarks, tracked_lines } = req.body;

    if (!product_id) {
      return res.status(400).json({ message: "product_id is required" });
    }

    const q = Number(quantity);
    if (!Number.isFinite(q) || q === 0) {
      return res.status(400).json({
        message: "quantity must be a non-zero number (can be negative)"
      });
    }

    const movementDate = parseDateOrNull(date) || new Date();

    const product = await prisma.product.findFirst({
      where: { id: product_id, company_id, is_active: true },
      select: { id: true }
    });

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    let movement;
    try {
      ({ movement } = await prisma.$transaction(
        (tx) =>
          createMovementTx(
            tx,
            {
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
            },
            { allowNegativeAdjustment: true, tracked_lines }
          ),
        TX_OPTS
      ));
    } catch (err) {
      if (
        err?.message === "INSUFFICIENT_STOCK" ||
        err?.message === "INSUFFICIENT_TRACKED_STOCK" ||
        err?.message === "SERIAL_NOT_AVAILABLE"
      ) {
        return res.status(err.statusCode || 400).json({
          message: err.message,
          ...(err.meta || {})
        });
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
    return res.status(err?.statusCode || 500).json({
      message: err?.message || "Internal server error",
      ...(err?.meta ? err.meta : {})
    });
  }
};

exports.getMovements = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const fw = factoryWhere(req);

    const product_id = (req.query.product_id || "").toString().trim();
    const type = (req.query.type || "").toString().trim();
    const source_type = (req.query.source_type || "").toString().trim();
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
            tracking_mode: true,
            category: { select: { id: true, name: true } }
          }
        },
        tracking_lines: { include: { batch: true, serial: true } }
      }
    };

    if (pagination.enabled) {
      query.skip = pagination.skip;
      query.take = pagination.take;
    }

    const [rows, total] = await Promise.all([
      prisma.inventoryMovement.findMany(query),
      pagination.enabled && pagination.include_total
        ? prisma.inventoryMovement.count({ where })
        : Promise.resolve(null)
    ]);

    if (!pagination.enabled) return res.json(rows);

    return res.json({
      items: rows,
      pagination: buildPaginationMeta({
        page: pagination.page,
        page_size: pagination.page_size,
        total: total ?? rows.length
      })
    });
  } catch (err) {
    console.error("getMovements error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

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
      const summary = await stockService.getFactoriesProductSummary(
        company_id,
        req.factory_ids,
        product_id,
        {
          date_from,
          date_to,
          as_of
        }
      );

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

exports.getStock = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const factory_id = req.factory_id;

    const category_id = (req.query.category_id || "").toString().trim();
    const product_id = (req.query.product_id || "").toString().trim();

    const include_totals = parseBoolean(req.query.include_totals);

    const as_of = parseDateOrNull(req.query.as_of);
    const date_from = parseDateOrNull(req.query.date_from);
    const date_to = parseDateOrNull(req.query.date_to);

    if (include_totals) {
      if (!product_id) {
        return res.status(400).json({
          message:
            "product_id is required when include_totals=true. Use /inventory/stock for list view and /inventory/stock-summary for product summary."
        });
      }

      if (!factory_id && Array.isArray(req.factory_ids) && req.factory_ids.length) {
        const summary = await stockService.getFactoriesProductSummary(
          company_id,
          req.factory_ids,
          product_id,
          {
            date_from,
            date_to,
            as_of
          }
        );
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

exports.getTrackedStock = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const factory_ids = req.factory_id
      ? [req.factory_id]
      : Array.isArray(req.factory_ids)
      ? req.factory_ids
      : [];

    const rows = await getTrackedStockView(prisma, {
      company_id,
      factory_ids,
      product_id: (req.query.product_id || "").toString().trim() || undefined,
      q: (req.query.q || "").toString().trim() || undefined,
      include_zero: parseBoolean(req.query.include_zero)
    });

    return res.json(rows);
  } catch (err) {
    console.error("getTrackedStock error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.resolveBarcode = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const code = (req.query.code || req.body?.code || "").toString().trim();
    if (!code) return res.status(400).json({ message: "code is required" });

    const productBarcode = await prisma.productBarcode.findFirst({
      where: { company_id, code, is_active: true },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            sku: true,
            unit: true,
            tracking_mode: true
          }
        }
      }
    });

    const serial = await prisma.inventorySerial.findFirst({
      where: { company_id, OR: [{ serial_no: code }, { barcode: code }] },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            tracking_mode: true
          }
        },
        batch: true
      }
    });

    const batch = await prisma.inventoryBatch.findFirst({
      where: { company_id, OR: [{ batch_no: code }, { barcode: code }] },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            tracking_mode: true
          }
        }
      }
    });

    return res.json({ product_barcode: productBarcode, serial, batch });
  } catch (err) {
    console.error("resolveBarcode error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getProductBarcodeLabelsPdf = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const product_id = req.params.productId;
    const outPath = buildTempPdfPath("barcode-labels", company_id, req.factory_id || "all", product_id);
    await generateProductBarcodeLabelsToFile({ company_id, product_id, outPath });
    return streamPdfAndDelete({
      res,
      filePath: outPath,
      filename: `barcode-labels-${product_id}.pdf`,
      inline: true
    });
  } catch (err) {
    console.error("getProductBarcodeLabelsPdf error:", err);
    return res.status(err.statusCode || 500).json({
      message: err.message || "Internal server error"
    });
  }
};