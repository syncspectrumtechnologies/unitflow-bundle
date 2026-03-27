const { Prisma } = require("@prisma/client");
const { applyTrackedMovementTx, getProductTrackingProfileTx } = require("./trackedInventoryService");

function toNumber(value) {
  const n = typeof value === "string" ? Number(value) : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function movementDelta(type, quantity) {
  const qty = toNumber(quantity);
  if (type === "IN") return qty;
  if (type === "OUT") return -qty;
  if (type === "ADJUSTMENT") return qty;
  throw new Error(`Unsupported movement type: ${type}`);
}

async function seedBalanceFromMovementsTx(tx, company_id, factory_id, product_id) {
  const [ins, outs, adjs] = await Promise.all([
    tx.inventoryMovement.aggregate({
      where: { company_id, factory_id, product_id, type: "IN" },
      _sum: { quantity: true }
    }),
    tx.inventoryMovement.aggregate({
      where: { company_id, factory_id, product_id, type: "OUT" },
      _sum: { quantity: true }
    }),
    tx.inventoryMovement.aggregate({
      where: { company_id, factory_id, product_id, type: "ADJUSTMENT" },
      _sum: { quantity: true }
    })
  ]);

  const quantity =
    toNumber(ins._sum.quantity) -
    toNumber(outs._sum.quantity) +
    toNumber(adjs._sum.quantity);

  return tx.stockBalance.upsert({
    where: {
      company_id_factory_id_product_id: { company_id, factory_id, product_id }
    },
    update: {},
    create: { company_id, factory_id, product_id, quantity }
  });
}

async function ensureBalanceRowTx(tx, company_id, factory_id, product_id) {
  const existing = await tx.stockBalance.findUnique({
    where: {
      company_id_factory_id_product_id: { company_id, factory_id, product_id }
    }
  });

  if (existing) return existing;
  return seedBalanceFromMovementsTx(tx, company_id, factory_id, product_id);
}

async function getBalanceTx(tx, company_id, factory_id, product_id) {
  const row = await ensureBalanceRowTx(tx, company_id, factory_id, product_id);
  return toNumber(row.quantity);
}

async function incrementBalanceTx(tx, company_id, factory_id, product_id, delta) {
  await ensureBalanceRowTx(tx, company_id, factory_id, product_id);
  return tx.stockBalance.update({
    where: {
      company_id_factory_id_product_id: { company_id, factory_id, product_id }
    },
    data: { quantity: { increment: delta } }
  });
}

async function decrementBalanceIfAvailableTx(tx, company_id, factory_id, product_id, amount) {
  await ensureBalanceRowTx(tx, company_id, factory_id, product_id);

  const updated = await tx.$executeRaw`
    UPDATE "StockBalance"
    SET "quantity" = "quantity" - ${amount}, "updated_at" = NOW()
    WHERE "company_id" = ${company_id}
      AND "factory_id" = ${factory_id}
      AND "product_id" = ${product_id}
      AND "quantity" >= ${amount}
  `;

  return updated > 0;
}

async function applyBalanceDeltaTx(
  tx,
  { company_id, factory_id, product_id, delta, allowNegative = false }
) {
  const numericDelta = toNumber(delta);

  if (numericDelta === 0) {
    await ensureBalanceRowTx(tx, company_id, factory_id, product_id);
    return getBalanceTx(tx, company_id, factory_id, product_id);
  }

  if (numericDelta > 0) {
    const row = await incrementBalanceTx(tx, company_id, factory_id, product_id, numericDelta);
    return toNumber(row.quantity);
  }

  const amount = Math.abs(numericDelta);

  if (allowNegative) {
    const row = await tx.stockBalance.update({
      where: {
        company_id_factory_id_product_id: { company_id, factory_id, product_id }
      },
      data: { quantity: { decrement: amount } }
    });
    return toNumber(row.quantity);
  }

  const ok = await decrementBalanceIfAvailableTx(tx, company_id, factory_id, product_id, amount);

  if (!ok) {
    const available_stock = await getBalanceTx(tx, company_id, factory_id, product_id);
    const err = new Error("INSUFFICIENT_STOCK");
    err.statusCode = 400;
    err.meta = {
      company_id,
      factory_id,
      product_id,
      available_stock,
      required_stock: amount
    };
    throw err;
  }

  return getBalanceTx(tx, company_id, factory_id, product_id);
}

async function createMovementTx(tx, data, options = {}) {
  const delta = movementDelta(data.type, data.quantity);
  const allowNegative = Boolean(options.allowNegativeAdjustment);

  const nextBalance = await applyBalanceDeltaTx(tx, {
    company_id: data.company_id,
    factory_id: data.factory_id,
    product_id: data.product_id,
    delta,
    allowNegative
  });

  const movement = await tx.inventoryMovement.create({
    data: {
      company_id: data.company_id,
      factory_id: data.factory_id,
      product_id: data.product_id,
      type: data.type,
      source_type: data.source_type,
      source_id: data.source_id ?? null,
      date: data.date ?? new Date(),
      quantity: data.quantity,
      unit_cost: data.unit_cost ?? null,
      remarks: data.remarks ?? null,
      created_by: data.created_by ?? null
    }
  });

  let tracking_lines = [];
  const requestedTrackedLines = options.tracked_lines || data.tracked_lines || [];

  const product = await getProductTrackingProfileTx(tx, {
    company_id: data.company_id,
    product_id: data.product_id
  });

  if (
    (product.tracking_mode && product.tracking_mode !== "NONE") ||
    (Array.isArray(requestedTrackedLines) && requestedTrackedLines.length)
  ) {
    tracking_lines = await applyTrackedMovementTx(tx, {
      movement,
      tracked_lines: requestedTrackedLines,
      allow_negative: allowNegative,
      product
    });
  }

  return { movement, balance_after: nextBalance, tracking_lines };
}

async function updateMovementTx(tx, existing, nextData, options = {}) {
  const trackingCount = await tx.inventoryMovementTracking.count({
    where: { movement_id: existing.id }
  });

  if (trackingCount > 0) {
    const err = new Error("TRACKED_MOVEMENT_UPDATE_NOT_SUPPORTED");
    err.statusCode = 400;
    throw err;
  }

  const oldFactoryId = existing.factory_id;
  const oldProductId = existing.product_id;
  const oldDelta = movementDelta(existing.type, existing.quantity);

  const newFactoryId = nextData.factory_id ?? existing.factory_id;
  const newProductId = nextData.product_id ?? existing.product_id;
  const newType = nextData.type ?? existing.type;
  const newQuantity = nextData.quantity ?? existing.quantity;
  const newDelta = movementDelta(newType, newQuantity);

  const allowNegative = Boolean(options.allowNegativeAdjustment);

  await applyBalanceDeltaTx(tx, {
    company_id: existing.company_id,
    factory_id: oldFactoryId,
    product_id: oldProductId,
    delta: -oldDelta,
    allowNegative: true
  });

  try {
    await applyBalanceDeltaTx(tx, {
      company_id: existing.company_id,
      factory_id: newFactoryId,
      product_id: newProductId,
      delta: newDelta,
      allowNegative
    });
  } catch (err) {
    await applyBalanceDeltaTx(tx, {
      company_id: existing.company_id,
      factory_id: oldFactoryId,
      product_id: oldProductId,
      delta: oldDelta,
      allowNegative: true
    });
    throw err;
  }

  return tx.inventoryMovement.update({
    where: { id: existing.id },
    data: nextData
  });
}

module.exports = {
  getBalanceTx,
  createMovementTx,
  updateMovementTx,
  applyBalanceDeltaTx,
  movementDelta,
  toNumber
};