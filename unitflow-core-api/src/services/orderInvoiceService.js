const { makeInvoiceNoTx } = require("../utils/numbering");

function toNum(v) {
  const n = typeof v === "string" ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function calcLineTotal(qty, price, discount) {
  const d = discount ? Number(discount) : 0;
  return qty * price - d;
}

function buildInvoiceItemsFromOrder({ company_id, order }) {
  return (order.items || []).map((it) => ({
    company_id,
    product_id: it.product_id,
    quantity: toNum(it.quantity),
    unit_price: toNum(it.unit_price),
    discount: it.discount !== null && it.discount !== undefined ? toNum(it.discount) : null,
    line_total: it.line_total !== null && it.line_total !== undefined
      ? toNum(it.line_total)
      : calcLineTotal(toNum(it.quantity), toNum(it.unit_price), it.discount ? toNum(it.discount) : 0),
    remarks: it.remarks || null
  }));
}

function buildInvoiceChargesFromOrder({ company_id, order }) {
  return (order.charges || []).map((c) => ({
    company_id,
    type: c.type,
    title: c.title,
    amount: toNum(c.amount),
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

  let inv = await tx.invoice.findFirst({
    where: { company_id, order_id: order.id, is_active: true }
  });
  if (inv) return { order, invoice: inv };

  const items = buildInvoiceItemsFromOrder({ company_id, order });
  const charges = buildInvoiceChargesFromOrder({ company_id, order });

  const subtotal = items.reduce((acc, it) => acc + toNum(it.line_total), 0);
  const total_charges = charges.reduce((acc, c) => acc + toNum(c.amount), 0);
  const total = subtotal + total_charges;

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

      subtotal,
      total_charges,
      total,

      notes: order.notes || null,
      is_active: true,
      created_by: user_id || null,

      items: {
        createMany: {
          data: items
        }
      },
      charges: {
        createMany: {
          data: charges
        }
      },
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

  // If invoice does not exist (legacy data), create it.
  const ensured = await ensureInvoiceForOrderTx(tx, { company_id, order_id: order.id, user_id });
  const inv = ensured.invoice;

  // Do not mutate voided invoices (order cancelled workflow).
  if (inv.status === "VOID") return { order, invoice: inv, synced: false };

  const items = buildInvoiceItemsFromOrder({ company_id, order });
  const charges = buildInvoiceChargesFromOrder({ company_id, order });

  // Replace items/charges to match the order (invoice is a derived document)
  await tx.invoiceItem.deleteMany({ where: { company_id, invoice_id: inv.id } });
  if (items.length) {
    await tx.invoiceItem.createMany({
      data: items.map((it) => ({ ...it, invoice_id: inv.id }))
    });
  }

  await tx.invoiceCharge.deleteMany({ where: { company_id, invoice_id: inv.id } });
  if (charges.length) {
    await tx.invoiceCharge.createMany({
      data: charges.map((c) => ({ ...c, invoice_id: inv.id }))
    });
  }

  const subtotal = items.reduce((acc, it) => acc + toNum(it.line_total), 0);
  const total_charges = charges.reduce((acc, c) => acc + toNum(c.amount), 0);
  const total = subtotal + total_charges;

  const updated = await tx.invoice.update({
    where: { id: inv.id },
    data: {
      factory_id: order.factory_id,
      client_id: order.client_id,
      sales_company_id: order.sales_company_id || null,
      issue_date: order.order_date,
      subtotal,
      total_charges,
      total,
      notes: order.notes || null
    }
  });

  return { order, invoice: updated, synced: true };
}

module.exports = {
  ensureInvoiceForOrderTx,
  syncInvoiceFromOrderTx
};
