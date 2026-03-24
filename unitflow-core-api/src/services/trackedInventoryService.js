const { toNumber, normalizeText, round2 } = require("./gstService");

const TRACKING_MODES = new Set([
  "NONE",
  "BARCODE_ONLY",
  "SERIAL_ONLY",
  "BATCH_ONLY",
  "BATCH_EXPIRY",
  "SERIAL_BATCH",
  "SERIAL_BATCH_EXPIRY"
]);

function normalizeTrackingMode(value) {
  const raw = (value || "NONE").toString().trim().toUpperCase();
  return TRACKING_MODES.has(raw) ? raw : "NONE";
}

function trackingCapabilities(mode) {
  const normalized = normalizeTrackingMode(mode);
  return {
    mode: normalized,
    requires_barcode: normalized === "BARCODE_ONLY",
    requires_serial: normalized === "SERIAL_ONLY" || normalized === "SERIAL_BATCH" || normalized === "SERIAL_BATCH_EXPIRY",
    requires_batch: normalized === "BATCH_ONLY" || normalized === "BATCH_EXPIRY" || normalized === "SERIAL_BATCH" || normalized === "SERIAL_BATCH_EXPIRY",
    requires_expiry: normalized === "BATCH_EXPIRY" || normalized === "SERIAL_BATCH_EXPIRY"
  };
}

function normalizeTrackedLines(lines) {
  if (!Array.isArray(lines)) return [];
  return lines.map((line) => ({
    batch_no: normalizeText(line.batch_no),
    serial_no: normalizeText(line.serial_no),
    barcode: normalizeText(line.barcode),
    expiry_date: line.expiry_date ? new Date(line.expiry_date) : null,
    manufacture_date: line.manufacture_date ? new Date(line.manufacture_date) : null,
    location_label: normalizeText(line.location_label),
    quantity: round2(toNumber(line.quantity || 0))
  })).filter((line) => line.quantity > 0 || line.serial_no);
}

async function getProductTrackingProfileTx(tx, { company_id, product_id }) {
  const product = await tx.product.findFirst({
    where: { id: product_id, company_id },
    include: { product_barcodes: { where: { is_active: true } } }
  });
  if (!product) {
    const err = new Error("PRODUCT_NOT_FOUND");
    err.statusCode = 404;
    err.meta = { product_id };
    throw err;
  }
  return product;
}

function validateTrackedLines({ product, quantity, tracked_lines }) {
  const caps = trackingCapabilities(product?.tracking_mode);
  const normalized = normalizeTrackedLines(tracked_lines);
  const qty = round2(toNumber(quantity));

  if (caps.mode === "NONE") {
    return { caps, lines: [] };
  }

  if (!normalized.length) {
    const err = new Error("TRACKED_LINES_REQUIRED");
    err.statusCode = 400;
    err.meta = { product_id: product.id, tracking_mode: caps.mode };
    throw err;
  }

  for (const line of normalized) {
    if (caps.requires_barcode && !line.barcode) {
      const err = new Error("TRACKED_BARCODE_REQUIRED");
      err.statusCode = 400;
      throw err;
    }
    if (caps.requires_batch && !line.batch_no) {
      const err = new Error("TRACKED_BATCH_REQUIRED");
      err.statusCode = 400;
      throw err;
    }
    if (caps.requires_expiry && !line.expiry_date) {
      const err = new Error("TRACKED_EXPIRY_REQUIRED");
      err.statusCode = 400;
      throw err;
    }
    if (caps.requires_serial) {
      if (!line.serial_no) {
        const err = new Error("TRACKED_SERIAL_REQUIRED");
        err.statusCode = 400;
        throw err;
      }
      if (Math.abs(round2(toNumber(line.quantity || 1)) - 1) > 1e-9) {
        const err = new Error("TRACKED_SERIAL_QUANTITY_INVALID");
        err.statusCode = 400;
        throw err;
      }
      line.quantity = 1;
    }
  }

  const total = round2(normalized.reduce((sum, line) => sum + round2(toNumber(line.quantity || 0)), 0));
  if (Math.abs(total - qty) > 1e-9) {
    const err = new Error("TRACKED_QUANTITY_MISMATCH");
    err.statusCode = 400;
    err.meta = { expected_quantity: qty, tracked_quantity: total };
    throw err;
  }

  return { caps, lines: normalized };
}

async function ensureProductBarcodeTx(tx, { company_id, product_id, barcode }) {
  if (!barcode) return null;
  const existing = await tx.productBarcode.findFirst({ where: { company_id, code: barcode } });
  if (existing) return existing;
  return tx.productBarcode.create({
    data: {
      company_id,
      product_id,
      code: barcode,
      alias_type: "INVENTORY",
      is_primary: false,
      is_active: true
    }
  });
}

async function findTrackingBalanceRowTx(tx, where) {
  return tx.inventoryTrackingBalance.findFirst({ where });
}

async function upsertTrackingBalanceTx(tx, data, delta, { allow_negative = false } = {}) {
  const where = {
    company_id: data.company_id,
    factory_id: data.factory_id,
    product_id: data.product_id,
    batch_id: data.batch_id || null,
    serial_id: data.serial_id || null,
    barcode: data.barcode || null,
    location_label: data.location_label || null
  };

  const existing = await findTrackingBalanceRowTx(tx, where);
  if (!existing) {
    if (delta < 0 && !allow_negative) {
      const err = new Error("INSUFFICIENT_TRACKED_STOCK");
      err.statusCode = 400;
      err.meta = { ...where, available_stock: 0, required_stock: Math.abs(delta) };
      throw err;
    }
    return tx.inventoryTrackingBalance.create({
      data: {
        ...where,
        expiry_date: data.expiry_date || null,
        quantity: delta
      }
    });
  }

  const nextQty = round2(toNumber(existing.quantity) + delta);
  if (nextQty < -1e-9 && !allow_negative) {
    const err = new Error("INSUFFICIENT_TRACKED_STOCK");
    err.statusCode = 400;
    err.meta = { ...where, available_stock: toNumber(existing.quantity), required_stock: Math.abs(delta) };
    throw err;
  }
  return tx.inventoryTrackingBalance.update({
    where: { id: existing.id },
    data: {
      expiry_date: data.expiry_date || existing.expiry_date,
      quantity: nextQty
    }
  });
}

async function ensureBatchTx(tx, { company_id, factory_id, product_id, batch_no, expiry_date, manufacture_date, barcode, location_label }) {
  if (!batch_no) return null;
  const existing = await tx.inventoryBatch.findFirst({
    where: { company_id, factory_id, product_id, batch_no }
  });
  if (existing) {
    return tx.inventoryBatch.update({
      where: { id: existing.id },
      data: {
        expiry_date: expiry_date || existing.expiry_date,
        manufacture_date: manufacture_date || existing.manufacture_date,
        barcode: barcode || existing.barcode,
        location_label: location_label || existing.location_label
      }
    });
  }

  return tx.inventoryBatch.create({
    data: {
      company_id,
      factory_id,
      product_id,
      batch_no,
      expiry_date: expiry_date || null,
      manufacture_date: manufacture_date || null,
      barcode: barcode || null,
      location_label: location_label || null
    }
  });
}

async function ensureSerialInTx(tx, { company_id, factory_id, product_id, serial_no, batch_id, barcode, expiry_date, location_label, movement_id }) {
  const existing = await tx.inventorySerial.findFirst({ where: { company_id, serial_no } });
  if (existing) {
    return tx.inventorySerial.update({
      where: { id: existing.id },
      data: {
        factory_id,
        product_id,
        batch_id: batch_id || existing.batch_id,
        barcode: barcode || existing.barcode,
        expiry_date: expiry_date || existing.expiry_date,
        location_label: location_label || existing.location_label,
        status: "IN_STOCK",
        last_movement_id: movement_id
      }
    });
  }

  return tx.inventorySerial.create({
    data: {
      company_id,
      factory_id,
      product_id,
      batch_id: batch_id || null,
      serial_no,
      barcode: barcode || null,
      expiry_date: expiry_date || null,
      location_label: location_label || null,
      status: "IN_STOCK",
      last_movement_id: movement_id || null
    }
  });
}

async function reserveSerialOutTx(tx, { company_id, factory_id, product_id, serial_no, movement_id }) {
  const serial = await tx.inventorySerial.findFirst({ where: { company_id, serial_no, product_id } });
  if (!serial || serial.status !== "IN_STOCK") {
    const err = new Error("SERIAL_NOT_AVAILABLE");
    err.statusCode = 400;
    err.meta = { company_id, product_id, serial_no };
    throw err;
  }
  return tx.inventorySerial.update({
    where: { id: serial.id },
    data: {
      factory_id,
      status: "DISPATCHED",
      last_movement_id: movement_id
    }
  });
}

async function applyTrackedMovementTx(tx, { movement, tracked_lines, allow_negative = false }) {
  const product = await getProductTrackingProfileTx(tx, {
    company_id: movement.company_id,
    product_id: movement.product_id
  });
  const { caps, lines } = validateTrackedLines({
    product,
    quantity: movement.quantity,
    tracked_lines
  });

  if (caps.mode === "NONE") return [];

  const direction = movement.type === "OUT" ? -1 : 1;
  const trackingRows = [];

  for (const line of lines) {
    await ensureProductBarcodeTx(tx, {
      company_id: movement.company_id,
      product_id: movement.product_id,
      barcode: line.barcode
    });

    let batch = null;
    if (line.batch_no) {
      batch = await ensureBatchTx(tx, {
        company_id: movement.company_id,
        factory_id: movement.factory_id,
        product_id: movement.product_id,
        batch_no: line.batch_no,
        expiry_date: line.expiry_date,
        manufacture_date: line.manufacture_date,
        barcode: line.barcode,
        location_label: line.location_label
      });
    }

    let serial = null;
    if (line.serial_no) {
      if (direction > 0) {
        serial = await ensureSerialInTx(tx, {
          company_id: movement.company_id,
          factory_id: movement.factory_id,
          product_id: movement.product_id,
          serial_no: line.serial_no,
          batch_id: batch?.id,
          barcode: line.barcode,
          expiry_date: line.expiry_date,
          location_label: line.location_label,
          movement_id: movement.id
        });
      } else {
        serial = await reserveSerialOutTx(tx, {
          company_id: movement.company_id,
          factory_id: movement.factory_id,
          product_id: movement.product_id,
          serial_no: line.serial_no,
          movement_id: movement.id
        });
      }
    }

    await upsertTrackingBalanceTx(tx, {
      company_id: movement.company_id,
      factory_id: movement.factory_id,
      product_id: movement.product_id,
      batch_id: batch?.id,
      serial_id: serial?.id,
      barcode: line.barcode,
      expiry_date: line.expiry_date,
      location_label: line.location_label
    }, round2(direction * toNumber(line.quantity)), { allow_negative });

    const row = await tx.inventoryMovementTracking.create({
      data: {
        company_id: movement.company_id,
        factory_id: movement.factory_id,
        product_id: movement.product_id,
        movement_id: movement.id,
        batch_id: batch?.id || null,
        serial_id: serial?.id || null,
        barcode: line.barcode || null,
        expiry_date: line.expiry_date || null,
        location_label: line.location_label || null,
        quantity: line.quantity || 1
      },
      include: {
        batch: true,
        serial: true
      }
    });
    trackingRows.push(row);
  }

  return trackingRows;
}

async function getTrackedStockView(prisma, { company_id, factory_ids, product_id, q, include_zero = false }) {
  const where = {
    company_id,
    ...(product_id ? { product_id } : {}),
    ...(Array.isArray(factory_ids) && factory_ids.length ? { factory_id: { in: factory_ids } } : {}),
    ...(!include_zero ? { quantity: { gt: 0 } } : {})
  };

  if (q) {
    where.OR = [
      { barcode: { contains: q, mode: "insensitive" } },
      { location_label: { contains: q, mode: "insensitive" } },
      { batch: { batch_no: { contains: q, mode: "insensitive" } } },
      { serial: { serial_no: { contains: q, mode: "insensitive" } } },
      { product: { name: { contains: q, mode: "insensitive" } } }
    ];
  }

  return prisma.inventoryTrackingBalance.findMany({
    where,
    orderBy: [{ updated_at: "desc" }, { id: "desc" }],
    include: {
      product: { select: { id: true, name: true, sku: true, unit: true, tracking_mode: true } },
      factory: { select: { id: true, name: true } },
      batch: true,
      serial: true
    }
  });
}

module.exports = {
  normalizeTrackingMode,
  trackingCapabilities,
  normalizeTrackedLines,
  getProductTrackingProfileTx,
  validateTrackedLines,
  applyTrackedMovementTx,
  getTrackedStockView
};
