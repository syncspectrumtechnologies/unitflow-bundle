function toNumber(value) {
  const n = typeof value === "string" ? Number(value) : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeText(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const s = String(value).trim();
  return s || null;
}

function normalizeStateCode(value) {
  if (value === undefined || value === null || value === "") return null;
  const digits = String(value).replace(/\D/g, "");
  if (!digits) return null;
  return digits.padStart(2, "0").slice(-2);
}

function gstinStateCode(gstin) {
  const s = (gstin || "").toString().trim().toUpperCase();
  if (!/^\d{2}[A-Z0-9]{13}$/.test(s)) return null;
  return s.slice(0, 2);
}

function inferStateCode({ gstin, state_code }) {
  return normalizeStateCode(state_code) || gstinStateCode(gstin) || null;
}

function resolveSupplyType({ seller_state_code, buyer_state_code, gst_registration_type }) {
  const regType = (gst_registration_type || "").toString().trim().toUpperCase();
  if (regType === "EXPORT") return "EXPORT";

  const seller = normalizeStateCode(seller_state_code);
  const buyer = normalizeStateCode(buyer_state_code);
  if (seller && buyer && seller === buyer) return "INTRA_STATE";
  return "INTER_STATE";
}

function splitRates({ gst_rate, cess_rate, supply_type }) {
  const gstRate = toNumber(gst_rate);
  const cessRate = toNumber(cess_rate);
  const supplyType = (supply_type || "INTER_STATE").toString().toUpperCase();

  if (supplyType === "INTRA_STATE") {
    const half = gstRate / 2;
    return { gst_rate: gstRate, cgst_rate: half, sgst_rate: half, igst_rate: 0, cess_rate: cessRate };
  }

  return { gst_rate: gstRate, cgst_rate: 0, sgst_rate: 0, igst_rate: gstRate, cess_rate: cessRate };
}

function resolveGstEnabled({ explicit_is_gst_invoice, company_is_gst_enabled, sales_company_is_gst_enabled, seller_gstin }) {
  if (typeof explicit_is_gst_invoice === "boolean") return explicit_is_gst_invoice;
  if (typeof sales_company_is_gst_enabled === "boolean") return sales_company_is_gst_enabled;
  if (typeof company_is_gst_enabled === "boolean") return company_is_gst_enabled;
  return Boolean(normalizeText(seller_gstin));
}

function round2(value) {
  return Math.round((toNumber(value) + Number.EPSILON) * 100) / 100;
}

function computeTaxLine({ quantity, unit_price, discount, gst_rate, cess_rate, supply_type, hsn_sac_code, gst_enabled = true }) {
  const qty = toNumber(quantity);
  const unitPrice = toNumber(unit_price);
  const disc = toNumber(discount);
  const gross = round2(qty * unitPrice);
  const taxableValue = round2(gross - disc);

  if (gst_enabled === false) {
    return {
      quantity: qty,
      unit_price: unitPrice,
      discount: disc || null,
      hsn_sac_code: normalizeText(hsn_sac_code),
      gst_rate: 0,
      cgst_rate: 0,
      sgst_rate: 0,
      igst_rate: 0,
      cess_rate: 0,
      taxable_value: taxableValue,
      tax_amount: 0,
      cgst_amount: 0,
      sgst_amount: 0,
      igst_amount: 0,
      cess_amount: 0,
      line_total: taxableValue
    };
  }

  const rates = splitRates({ gst_rate, cess_rate, supply_type });

  const cgst_amount = round2(taxableValue * rates.cgst_rate / 100);
  const sgst_amount = round2(taxableValue * rates.sgst_rate / 100);
  const igst_amount = round2(taxableValue * rates.igst_rate / 100);
  const cess_amount = round2(taxableValue * rates.cess_rate / 100);
  const tax_amount = round2(cgst_amount + sgst_amount + igst_amount + cess_amount);
  const line_total = round2(taxableValue + tax_amount);

  return {
    quantity: qty,
    unit_price: unitPrice,
    discount: disc || null,
    hsn_sac_code: normalizeText(hsn_sac_code),
    gst_rate: rates.gst_rate,
    cgst_rate: rates.cgst_rate,
    sgst_rate: rates.sgst_rate,
    igst_rate: rates.igst_rate,
    cess_rate: rates.cess_rate,
    taxable_value: taxableValue,
    tax_amount,
    cgst_amount,
    sgst_amount,
    igst_amount,
    cess_amount,
    line_total
  };
}

function summarizeTaxLines(lines = [], chargesTotal = 0, roundOff = 0) {
  const summary = {
    subtotal: 0,
    tax_subtotal: 0,
    total_charges: round2(chargesTotal),
    cgst_total: 0,
    sgst_total: 0,
    igst_total: 0,
    cess_total: 0,
    round_off: round2(roundOff),
    total: 0,
    gst_breakup: []
  };

  const breakup = new Map();
  for (const line of lines) {
    summary.subtotal = round2(summary.subtotal + toNumber(line.taxable_value));
    summary.tax_subtotal = round2(summary.tax_subtotal + toNumber(line.tax_amount));
    summary.cgst_total = round2(summary.cgst_total + toNumber(line.cgst_amount));
    summary.sgst_total = round2(summary.sgst_total + toNumber(line.sgst_amount));
    summary.igst_total = round2(summary.igst_total + toNumber(line.igst_amount));
    summary.cess_total = round2(summary.cess_total + toNumber(line.cess_amount));

    const key = [line.hsn_sac_code || "UNSPECIFIED", toNumber(line.gst_rate).toFixed(2), toNumber(line.cess_rate).toFixed(2)].join("|");
    const row = breakup.get(key) || {
      hsn_sac_code: line.hsn_sac_code || null,
      gst_rate: toNumber(line.gst_rate),
      cess_rate: toNumber(line.cess_rate),
      taxable_value: 0,
      cgst_amount: 0,
      sgst_amount: 0,
      igst_amount: 0,
      cess_amount: 0,
      tax_amount: 0
    };
    row.taxable_value = round2(row.taxable_value + toNumber(line.taxable_value));
    row.cgst_amount = round2(row.cgst_amount + toNumber(line.cgst_amount));
    row.sgst_amount = round2(row.sgst_amount + toNumber(line.sgst_amount));
    row.igst_amount = round2(row.igst_amount + toNumber(line.igst_amount));
    row.cess_amount = round2(row.cess_amount + toNumber(line.cess_amount));
    row.tax_amount = round2(row.tax_amount + toNumber(line.tax_amount));
    breakup.set(key, row);
  }

  summary.total = round2(
    summary.subtotal +
    summary.tax_subtotal +
    summary.total_charges +
    summary.round_off
  );
  summary.gst_breakup = [...breakup.values()];
  return summary;
}

function selectProductTaxProfile(product) {
  const taxClass = product?.tax_class || null;
  return {
    hsn_sac_code: normalizeText(product?.hsn_sac_code) || normalizeText(taxClass?.name) || null,
    gst_rate: product?.gst_rate !== null && product?.gst_rate !== undefined ? toNumber(product.gst_rate) : toNumber(taxClass?.gst_rate),
    cess_rate: product?.cess_rate !== null && product?.cess_rate !== undefined ? toNumber(product.cess_rate) : toNumber(taxClass?.cess_rate)
  };
}

module.exports = {
  toNumber,
  round2,
  normalizeText,
  normalizeStateCode,
  gstinStateCode,
  inferStateCode,
  resolveSupplyType,
  resolveGstEnabled,
  splitRates,
  computeTaxLine,
  summarizeTaxLines,
  selectProductTaxProfile
};
