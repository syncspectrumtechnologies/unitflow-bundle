const { makeInvoiceNoTx } = require("../utils/numbering");
const { summarizeCharges, summarizeTaxLines } = require("./documentTaxService");

function toNum(v) {
  const n = typeof v === "string" ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function buildInvoiceItemsFromOrder({ company_id, order }) {
  return (order.items || []).map((it) => ({
    company_id,
    product_id: it.product_id,
    quantity: toNum(it.quantity),
    unit_price: toNum(it.unit_price),
    discount: it.discount !== null && it.discount !== undefined ? toNum(it.discount) : null,
    line_total: toNum(it.line_total),
    hsn_sac_code: it.hsn_sac_code || null,
    gst_rate: it.gst_rate !== null && it.gst_rate !== undefined ? toNum(it.gst_rate) : null,
    cgst_rate: it.cgst_rate !== null && it.cgst_rate !== undefined ? toNum(it.cgst_rate) : null,
    sgst_rate: it.sgst_rate !== null && it.sgst_rate !== undefined ? toNum(it.sgst_rate) : null,
    igst_rate: it.igst_rate !== null && it.igst_rate !== undefined ? toNum(it.igst_rate) : null,
    cess_rate: it.cess_rate !== null && it.cess_rate !== undefined ? toNum(it.cess_rate) : null,
    taxable_value: it.taxable_value !== null && it.taxable_value !== undefined ? toNum(it.taxable_value) : null,
    tax_amount: it.tax_amount !== null && it.tax_amount !== undefined ? toNum(it.tax_amount) : null,
    cgst_amount: it.cgst_amount !== null && it.cgst_amount !== undefined ? toNum(it.cgst_amount) : null,
    sgst_amount: it.sgst_amount !== null && it.sgst_amount !== undefined ? toNum(it.sgst_amount) : null,
    igst_amount: it.igst_amount !== null && it.igst_amount !== undefined ? toNum(it.igst_amount) : null,
    cess_amount: it.cess_amount !== null && it.cess_amount !== undefined ? toNum(it.cess_amount) : null,
    remarks: it.remarks || null
  }));
}

function buildInvoiceChargesFromOrder({ company_id, order }) {
  return summarizeCharges(order.charges || []).map((c) => ({
    company_id,
    type: c.type,
    title: c.title,
    amount: c.amount,
    meta: c.meta || null
  }));
}

async function ensureInvoiceForOrderTx(tx, { company_id, order_id, user_id }) {
  const order = await tx.order.findFirst({
    where: { id: order_id, company_id, is_active: true },
    include: { items: true, charges: true }
  });
  if (!order) {
    const err = new Error("ORDER_NOT_FOUND");
    err.statusCode = 404;
    throw err;
  }

  let inv = await tx.invoice.findFirst({ where: { company_id, order_id: order.id, is_active: true } });
  if (inv) return { order, invoice: inv };

  const items = buildInvoiceItemsFromOrder({ company_id, order });
  const charges = buildInvoiceChargesFromOrder({ company_id, order });
  const chargeTotal = charges.reduce((sum, c) => sum + toNum(c.amount), 0);
  const taxTotals = summarizeTaxLines(items, chargeTotal, order.round_off || 0);
  if (order.is_gst_invoice === false) taxTotals.gst_breakup = [];
  const invoice_no = await makeInvoiceNoTx(tx, company_id, order.order_date || new Date());

  inv = await tx.invoice.create({
    data: {
      company_id,
      factory_id: order.factory_id,
      client_id: order.client_id,
      order_id: order.id,
      sales_company_id: order.sales_company_id || null,
      invoice_no,
      kind: "TAX_INVOICE",
      status: "PENDING",
      issue_date: order.order_date,
      due_date: null,
      place_of_supply_state: order.place_of_supply_state || null,
      place_of_supply_code: order.place_of_supply_code || null,
      supply_type: order.is_gst_invoice === false ? null : (order.supply_type || null),
      is_gst_invoice: order.is_gst_invoice !== false,
      subtotal: taxTotals.subtotal,
      tax_subtotal: taxTotals.tax_subtotal,
      total_charges: chargeTotal,
      cgst_total: taxTotals.cgst_total,
      sgst_total: taxTotals.sgst_total,
      igst_total: taxTotals.igst_total,
      cess_total: taxTotals.cess_total,
      round_off: taxTotals.round_off,
      total: taxTotals.total,
      gst_breakup: taxTotals.gst_breakup,
      notes: order.notes || null,
      is_active: true,
      created_by: user_id || null,
      items: { createMany: { data: items } },
      charges: { createMany: { data: charges } },
      status_history: {
        create: {
          company_id,
          status: "PENDING",
          note: "Invoice auto-created from order",
          created_by: user_id || null
        }
      }
    }
  });

  return { order, invoice: inv };
}

async function syncInvoiceFromOrderTx(tx, { company_id, order_id, user_id }) {
  const order = await tx.order.findFirst({
    where: { id: order_id, company_id, is_active: true },
    include: { items: true, charges: true }
  });
  if (!order) {
    const err = new Error("ORDER_NOT_FOUND");
    err.statusCode = 404;
    throw err;
  }

  const ensured = await ensureInvoiceForOrderTx(tx, { company_id, order_id: order.id, user_id });
  const inv = ensured.invoice;
  if (inv.status === "VOID") return { order, invoice: inv, synced: false };

  const items = buildInvoiceItemsFromOrder({ company_id, order });
  const charges = buildInvoiceChargesFromOrder({ company_id, order });
  const chargeTotal = charges.reduce((sum, c) => sum + toNum(c.amount), 0);
  const taxTotals = summarizeTaxLines(items, chargeTotal, order.round_off || 0);
  if (order.is_gst_invoice === false) taxTotals.gst_breakup = [];

  await tx.invoiceItem.deleteMany({ where: { company_id, invoice_id: inv.id } });
  if (items.length) {
    await tx.invoiceItem.createMany({ data: items.map((it) => ({ ...it, invoice_id: inv.id })) });
  }

  await tx.invoiceCharge.deleteMany({ where: { company_id, invoice_id: inv.id } });
  if (charges.length) {
    await tx.invoiceCharge.createMany({ data: charges.map((c) => ({ ...c, invoice_id: inv.id })) });
  }

  const updated = await tx.invoice.update({
    where: { id: inv.id },
    data: {
      factory_id: order.factory_id,
      client_id: order.client_id,
      sales_company_id: order.sales_company_id || null,
      issue_date: order.order_date,
      place_of_supply_state: order.place_of_supply_state || null,
      place_of_supply_code: order.place_of_supply_code || null,
      supply_type: order.is_gst_invoice === false ? null : (order.supply_type || null),
      is_gst_invoice: order.is_gst_invoice !== false,
      subtotal: taxTotals.subtotal,
      tax_subtotal: taxTotals.tax_subtotal,
      total_charges: chargeTotal,
      cgst_total: taxTotals.cgst_total,
      sgst_total: taxTotals.sgst_total,
      igst_total: taxTotals.igst_total,
      cess_total: taxTotals.cess_total,
      round_off: taxTotals.round_off,
      total: taxTotals.total,
      gst_breakup: taxTotals.gst_breakup,
      notes: order.notes || null
    }
  });

  return { order, invoice: updated, synced: true };
}

module.exports = {
  ensureInvoiceForOrderTx,
  syncInvoiceFromOrderTx
};
