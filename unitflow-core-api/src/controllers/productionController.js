const prisma = require("../config/db");
const logActivity = require("../utils/activityLogger");
const { factoryWhere, requireSingleFactory } = require("../utils/factoryScope");
const { createMovementTx, updateMovementTx } = require("../services/inventoryLedgerService");
const { getPagination, buildPaginationMeta } = require("../utils/pagination");

const TX_OPTS = {
  maxWait: 10000,
  timeout: 30000
};

function parseDateOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

exports.createProduction = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const factory_id = requireSingleFactory(req);

    const { product_id, date, quantity, remarks, tracked_lines, consumptions = [] } = req.body;

    if (!product_id) return res.status(400).json({ message: "product_id is required" });
    if (quantity === undefined || quantity === null) {
      return res.status(400).json({ message: "quantity is required" });
    }

    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ message: "quantity must be a number > 0" });
    }

    const prodDate = parseDateOrNull(date) || new Date();

    const product = await prisma.product.findFirst({
      where: { id: product_id, company_id, is_active: true },
      select: { id: true }
    });

    if (!product) return res.status(404).json({ message: "Product not found" });

    const result = await prisma.$transaction(
      async (tx) => {
        const productionLog = await tx.productionLog.create({
          data: {
            company_id,
            factory_id,
            product_id,
            date: prodDate,
            quantity: qty,
            remarks: remarks?.toString() || null,
            created_by: req.user.id
          }
        });

        const consumptionRows = Array.isArray(consumptions) ? consumptions : [];
        for (const row of consumptionRows) {
          if (!row.product_id) {
            const err = new Error("consumptions.product_id is required");
            err.statusCode = 400;
            throw err;
          }

          const consumeQty = Number(row.quantity);
          if (!Number.isFinite(consumeQty) || consumeQty <= 0) {
            const err = new Error("consumptions.quantity must be > 0");
            err.statusCode = 400;
            throw err;
          }

          await createMovementTx(
            tx,
            {
              company_id,
              factory_id,
              product_id: row.product_id,
              type: "OUT",
              source_type: "PRODUCTION",
              source_id: productionLog.id,
              date: prodDate,
              quantity: consumeQty,
              remarks: row.remarks?.toString() || `Production consumption for ${productionLog.id}`,
              created_by: req.user.id
            },
            { tracked_lines: row.tracked_lines || [] }
          );
        }

        const { movement } = await createMovementTx(
          tx,
          {
            company_id,
            factory_id,
            product_id,
            type: "IN",
            source_type: "PRODUCTION",
            source_id: productionLog.id,
            date: prodDate,
            quantity: qty,
            remarks: remarks?.toString() || null,
            created_by: req.user.id
          },
          { tracked_lines }
        );

        return { productionLog, movement };
      },
      TX_OPTS
    );

    await logActivity({
      company_id,
      factory_id,
      user_id: req.user.id,
      action: "PRODUCTION_CREATED",
      entity_type: "production_log",
      entity_id: result.productionLog.id,
      meta: { inventory_movement_id: result.movement.id },
      new_value: result.productionLog
    });

    return res.status(201).json(result);
  } catch (err) {
    console.error("createProduction error:", err);
    return res.status(err.statusCode || 500).json({
      message: err.message || "Internal server error",
      ...(err.meta ? err.meta : {})
    });
  }
};

exports.getProduction = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const fw = factoryWhere(req);

    const product_id = (req.query.product_id || "").toString().trim();
    const category_id = (req.query.category_id || "").toString().trim();

    const date_from = parseDateOrNull(req.query.date_from);
    const date_to = parseDateOrNull(req.query.date_to);

    const where = { company_id, ...fw };

    if (product_id) where.product_id = product_id;

    if (date_from || date_to) {
      where.date = {};
      if (date_from) where.date.gte = date_from;
      if (date_to) where.date.lte = date_to;
    }

    if (category_id) {
      where.product = { category_id };
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

    const [logs, total] = await Promise.all([
      prisma.productionLog.findMany(query),
      pagination.enabled && pagination.include_total
        ? prisma.productionLog.count({ where })
        : Promise.resolve(null)
    ]);

    if (!pagination.enabled) return res.json(logs);

    return res.json({
      items: logs,
      pagination: buildPaginationMeta({
        page: pagination.page,
        page_size: pagination.page_size,
        total: total ?? logs.length
      })
    });
  } catch (err) {
    console.error("getProduction error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.updateProduction = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const factory_id = requireSingleFactory(req);
    const { id } = req.params;

    const existing = await prisma.productionLog.findFirst({
      where: { id, company_id, factory_id }
    });

    if (!existing) return res.status(404).json({ message: "Production log not found" });

    const { product_id, date, quantity, remarks } = req.body;

    let nextQty = existing.quantity;
    if (quantity !== undefined && quantity !== null) {
      const q = Number(quantity);
      if (!Number.isFinite(q) || q <= 0) {
        return res.status(400).json({ message: "quantity must be a number > 0" });
      }
      nextQty = q;
    }

    let nextDate = existing.date;
    if (date !== undefined) {
      const d = parseDateOrNull(date);
      if (!d) return res.status(400).json({ message: "Invalid date format" });
      nextDate = d;
    }

    let nextProductId = existing.product_id;
    if (product_id !== undefined) {
      const product = await prisma.product.findFirst({
        where: { id: product_id, company_id, is_active: true },
        select: { id: true }
      });

      if (!product) return res.status(404).json({ message: "Product not found" });
      nextProductId = product_id;
    }

    const updated = await prisma.$transaction(
      async (tx) => {
        const prod = await tx.productionLog.update({
          where: { id },
          data: {
            product_id: product_id !== undefined ? nextProductId : undefined,
            date: date !== undefined ? nextDate : undefined,
            quantity: quantity !== undefined ? nextQty : undefined,
            remarks: remarks !== undefined ? remarks?.toString() || null : undefined
          }
        });

        const movement = await tx.inventoryMovement.findFirst({
          where: {
            company_id,
            factory_id,
            source_type: "PRODUCTION",
            source_id: id,
            type: "IN"
          }
        });

        if (!movement) {
          await createMovementTx(tx, {
            company_id,
            factory_id,
            product_id: nextProductId,
            type: "IN",
            source_type: "PRODUCTION",
            source_id: id,
            date: nextDate,
            quantity: nextQty,
            remarks: remarks?.toString() || prod.remarks || null,
            created_by: req.user.id
          });
        } else {
          await updateMovementTx(tx, movement, {
            product_id: nextProductId,
            date: nextDate,
            quantity: nextQty,
            remarks: remarks !== undefined ? remarks?.toString() || null : movement.remarks
          });
        }

        return prod;
      },
      TX_OPTS
    );

    await logActivity({
      company_id,
      factory_id,
      user_id: req.user.id,
      action: "PRODUCTION_UPDATED",
      entity_type: "production_log",
      entity_id: id,
      old_value: existing,
      new_value: updated
    });

    return res.json(updated);
  } catch (err) {
    console.error("updateProduction error:", err);
    return res.status(err.statusCode || 500).json({
      message: err.message || "Internal server error",
      ...(err.meta ? err.meta : {})
    });
  }
};