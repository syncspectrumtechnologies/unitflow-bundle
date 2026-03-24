const { computeTaxLine, summarizeTaxLines, selectProductTaxProfile, inferStateCode, resolveSupplyType, resolveGstEnabled, toNumber, normalizeText } = require("./gstService");

async function resolveSalesGstContextTx(tx, { company_id, sales_company_id, client_id, explicit_place_of_supply_code, explicit_is_gst_invoice }) {
  const [salesCompany, client, company] = await Promise.all([
    sales_company_id ? tx.salesCompany.findFirst({ where: { id: sales_company_id, company_id } }) : null,
    client_id ? tx.client.findFirst({ where: { id: client_id, company_id } }) : null,
    tx.company.findFirst({ where: { id: company_id } })
  ]);

  const sellerStateCode = inferStateCode({ gstin: salesCompany?.gstin || company?.gstin, state_code: salesCompany?.state_code || company?.state_code });
  const buyerStateCode = explicit_place_of_supply_code || inferStateCode({ gstin: client?.gstin, state_code: client?.state_code });
  const is_gst_invoice = resolveGstEnabled({
    explicit_is_gst_invoice,
    company_is_gst_enabled: company?.is_gst_enabled,
    sales_company_is_gst_enabled: salesCompany?.is_gst_enabled,
    seller_gstin: salesCompany?.gstin || company?.gstin
  });
  const supply_type = is_gst_invoice
    ? resolveSupplyType({
        seller_state_code: sellerStateCode,
        buyer_state_code: buyerStateCode,
        gst_registration_type: client?.gst_registration_type
      })
    : null;

  return {
    company,
    sales_company: salesCompany,
    client,
    is_gst_invoice,
    place_of_supply_state: is_gst_invoice ? (client?.state || null) : null,
    place_of_supply_code: is_gst_invoice ? buyerStateCode : null,
    supply_type
  };
}

async function buildSalesItemsFromPayloadTx(tx, { company_id, client_id, items, supply_type, is_gst_invoice = true }) {
  const productIds = [...new Set((items || []).map((row) => row.product_id).filter(Boolean))];
  const [products, clientProductRows] = await Promise.all([
    tx.product.findMany({
      where: { company_id, id: { in: productIds }, is_active: true },
      include: { tax_class: true }
    }),
    client_id ? tx.clientProduct.findMany({
      where: { company_id, client_id, product_id: { in: productIds }, is_active: true },
      select: { product_id: true, default_price: true }
    }) : []
  ]);

  if (products.length !== productIds.length) {
    const found = new Set(products.map((row) => row.id));
    const missing = productIds.filter((id) => !found.has(id));
    const err = new Error("PRODUCT_NOT_FOUND");
    err.statusCode = 404;
    err.meta = { missing_product_ids: missing };
    throw err;
  }

  const byId = new Map(products.map((row) => [row.id, row]));
  const defaultPrice = new Map(clientProductRows.map((row) => [row.product_id, row.default_price !== null && row.default_price !== undefined ? Number(row.default_price) : null]));

  const normalized = (items || []).map((row) => {
    const product = byId.get(row.product_id);
    const unit_price = row.unit_price !== undefined && row.unit_price !== null && row.unit_price !== ""
      ? Number(row.unit_price)
      : Number(defaultPrice.get(row.product_id) ?? product.price ?? 0);
    if (!Number.isFinite(unit_price) || unit_price < 0) {
      const err = new Error("INVALID_PRICE");
      err.statusCode = 400;
      throw err;
    }
    const quantity = Number(row.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      const err = new Error("INVALID_QTY");
      err.statusCode = 400;
      throw err;
    }
    const taxProfile = selectProductTaxProfile(product);
    const taxLine = computeTaxLine({
      quantity,
      unit_price,
      discount: row.discount,
      gst_rate: row.gst_rate !== undefined ? row.gst_rate : taxProfile.gst_rate,
      cess_rate: row.cess_rate !== undefined ? row.cess_rate : taxProfile.cess_rate,
      supply_type,
      hsn_sac_code: row.hsn_sac_code || taxProfile.hsn_sac_code,
      gst_enabled: is_gst_invoice
    });

    return {
      product_id: row.product_id,
      quantity,
      unit_price,
      discount: row.discount !== undefined && row.discount !== null ? Number(row.discount) : null,
      line_total: taxLine.line_total,
      hsn_sac_code: taxLine.hsn_sac_code,
      gst_rate: taxLine.gst_rate,
      cgst_rate: taxLine.cgst_rate,
      sgst_rate: taxLine.sgst_rate,
      igst_rate: taxLine.igst_rate,
      cess_rate: taxLine.cess_rate,
      taxable_value: taxLine.taxable_value,
      tax_amount: taxLine.tax_amount,
      cgst_amount: taxLine.cgst_amount,
      sgst_amount: taxLine.sgst_amount,
      igst_amount: taxLine.igst_amount,
      cess_amount: taxLine.cess_amount,
      remarks: normalizeText(row.remarks)
    };
  });

  const totals = summarizeTaxLines(normalized);
  if (!is_gst_invoice) totals.gst_breakup = [];
  return { items: normalized, totals };
}

async function buildPurchaseItemsFromPayloadTx(tx, { company_id, items, supply_type }) {
  const productIds = [...new Set((items || []).map((row) => row.product_id).filter(Boolean))];
  const products = productIds.length
    ? await tx.product.findMany({ where: { company_id, id: { in: productIds }, is_active: true }, include: { tax_class: true } })
    : [];
  const byId = new Map(products.map((row) => [row.id, row]));

  const normalized = (items || []).map((row) => {
    const quantity = Number(row.quantity);
    const unit_price = Number(row.unit_price);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      const err = new Error("INVALID_QTY");
      err.statusCode = 400;
      throw err;
    }
    if (!Number.isFinite(unit_price) || unit_price < 0) {
      const err = new Error("INVALID_PRICE");
      err.statusCode = 400;
      throw err;
    }
    const product = row.product_id ? byId.get(row.product_id) : null;
    const taxProfile = product ? selectProductTaxProfile(product) : { hsn_sac_code: row.hsn_sac_code || null, gst_rate: row.gst_rate || 0, cess_rate: row.cess_rate || 0 };
    const taxLine = computeTaxLine({
      quantity,
      unit_price,
      discount: row.discount,
      gst_rate: row.gst_rate !== undefined ? row.gst_rate : taxProfile.gst_rate,
      cess_rate: row.cess_rate !== undefined ? row.cess_rate : taxProfile.cess_rate,
      supply_type,
      hsn_sac_code: row.hsn_sac_code || taxProfile.hsn_sac_code
    });

    return {
      product_id: row.product_id || null,
      description: normalizeText(row.description) || product?.name || "Item",
      unit: normalizeText(row.unit) || product?.unit || null,
      quantity,
      unit_price,
      discount: row.discount !== undefined && row.discount !== null ? Number(row.discount) : null,
      line_total: taxLine.line_total,
      hsn_sac_code: taxLine.hsn_sac_code,
      gst_rate: taxLine.gst_rate,
      cgst_rate: taxLine.cgst_rate,
      sgst_rate: taxLine.sgst_rate,
      igst_rate: taxLine.igst_rate,
      cess_rate: taxLine.cess_rate,
      taxable_value: taxLine.taxable_value,
      tax_amount: taxLine.tax_amount,
      cgst_amount: taxLine.cgst_amount,
      sgst_amount: taxLine.sgst_amount,
      igst_amount: taxLine.igst_amount,
      cess_amount: taxLine.cess_amount
    };
  });

  return {
    items: normalized,
    totals: summarizeTaxLines(normalized)
  };
}

function summarizeCharges(charges = []) {
  return (charges || []).map((row) => ({
    type: row.type || "OTHER",
    title: row.title ? String(row.title).trim() : (row.label ? String(row.label).trim() : "Charge"),
    label: row.label ? String(row.label).trim() : (row.title ? String(row.title).trim() : "Charge"),
    amount: toNumber(row.amount || 0),
    meta: row.meta || null
  }));
}

module.exports = {
  resolveSalesGstContextTx,
  buildSalesItemsFromPayloadTx,
  buildPurchaseItemsFromPayloadTx,
  summarizeCharges,
  summarizeTaxLines
};
