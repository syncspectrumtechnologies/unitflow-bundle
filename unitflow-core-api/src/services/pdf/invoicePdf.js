const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const prisma = require("../../config/db");

const THEME = (process.env.PDF_THEME_COLOR || "#022999").trim();

function resolveLogoPath() {
  const p = process.env.INVOICE_LOGO_PATH || "src/assets/unitflow-logo-placeholder.jpeg";
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

async function fetchInvoice(company_id, factory_id, invoiceId) {
  return prisma.invoice.findFirst({
    where: { id: invoiceId, company_id, factory_id, is_active: true },
    include: {
      client: true,
      items: { include: { product: { include: { category: true } } } },
      charges: true,
      factory: true,
      company: true,
      sales_company: true,
      reference_invoice: { select: { id: true, invoice_no: true, kind: true } }
    }
  });
}

function money(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? n.toFixed(2) : "0.00";
}

function safeText(v) {
  return v ? String(v) : "";
}

function drawWatermark(doc, text) {
  const page = doc.page;
  const cx = page.width / 2;
  const cy = page.height / 2;
  doc.save();
  doc.fillColor("#9ca3af");
  doc.fillOpacity(0.12);
  doc.font("Helvetica-Bold").fontSize(100);
  doc.rotate(-35, { origin: [cx, cy] });
  doc.text(text, -40, cy - 50, { width: page.width + 80, align: "center", lineBreak: false });
  doc.restore();
}

function drawHeader(doc, inv) {
  const left = doc.page.margins.left;
  const pageWidth = doc.page.width;
  const contentWidth = pageWidth - doc.page.margins.left - doc.page.margins.right;
  const headerH = 112;
  const isGstInvoice = inv.is_gst_invoice !== false;

  doc.save();
  doc.rect(0, 0, pageWidth, headerH).fill(THEME);
  doc.restore();

  const logoPath = resolveLogoPath();
  if (fs.existsSync(logoPath)) {
    doc.save();
    doc.roundedRect(left, 24, 60, 60, 8).fill("#ffffff");
    doc.restore();
    doc.image(logoPath, left + 4, 28, { fit: [52, 52], align: "center", valign: "center" });
  }

  const title = inv.kind === "PROFORMA"
    ? "PROFORMA INVOICE"
    : inv.kind === "CREDIT_NOTE"
      ? "CREDIT NOTE"
      : inv.kind === "DEBIT_NOTE"
        ? "DEBIT NOTE"
        : (isGstInvoice ? "TAX INVOICE" : "INVOICE");

  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(18);
  doc.text(title, left + 80, 18, { width: contentWidth - 80, align: "right" });
  doc.font("Helvetica").fontSize(10).fillColor("#eaf6fb");
  const meta = [
    `Invoice No: ${safeText(inv.invoice_no)}`,
    `Status: ${safeText(inv.status)}`,
    `Issue Date: ${new Date(inv.issue_date).toLocaleDateString()}`,
    inv.due_date ? `Due Date: ${new Date(inv.due_date).toLocaleDateString()}` : null,
    inv.order_id ? `Order Ref: ${safeText(inv.order_id)}` : null,
    inv.reference_invoice?.invoice_no ? `Ref Invoice: ${inv.reference_invoice.invoice_no}` : null,
    isGstInvoice && inv.place_of_supply_code ? `Place of Supply: ${inv.place_of_supply_code}${inv.place_of_supply_state ? ` / ${inv.place_of_supply_state}` : ""}` : null,
    isGstInvoice && inv.supply_type ? `Supply Type: ${inv.supply_type}` : null,
    !isGstInvoice ? "Document Type: Non-GST invoice" : null
  ].filter(Boolean);
  let y = 40;
  for (const line of meta) {
    doc.text(line, left + 80, y, { width: contentWidth - 80, align: "right" });
    y += 12;
  }

  doc.y = headerH + 16;
}

function drawEntityBlocks(doc, inv) {
  const entity = inv.sales_company || inv.company || {};
  const client = inv.client || {};
  const left = doc.page.margins.left;
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const blockW = (contentWidth - 14) / 2;
  const blockY = doc.y;
  const blockH = 108;
  const isGstInvoice = inv.is_gst_invoice !== false;

  doc.roundedRect(left, blockY, blockW, blockH, 8).stroke("#d1d5db");
  doc.roundedRect(left + blockW + 14, blockY, blockW, blockH, 8).stroke("#d1d5db");

  doc.fillColor(THEME).font("Helvetica-Bold").fontSize(11).text("From", left + 10, blockY + 10);
  doc.fillColor("#111827").font("Helvetica-Bold").fontSize(12).text(safeText(entity.legal_name || entity.name || inv.company?.name || "UnitFlow"), left + 10, blockY + 26, { width: blockW - 20 });
  doc.font("Helvetica").fontSize(10).fillColor("#374151");
  const fromLines = [
    entity.address || inv.factory?.address || inv.company?.address,
    isGstInvoice && entity.gstin ? `GSTIN: ${entity.gstin}` : null,
    entity.phone ? `Phone: ${entity.phone}` : null,
    entity.email ? `Email: ${entity.email}` : null,
    entity.state_code || entity.state ? `State: ${safeText(entity.state_code)} ${safeText(entity.state)}`.trim() : null
  ].filter(Boolean);
  let y = blockY + 44;
  fromLines.forEach((line) => {
    doc.text(line, left + 10, y, { width: blockW - 20 });
    y += 13;
  });

  const rx = left + blockW + 14;
  doc.fillColor(THEME).font("Helvetica-Bold").fontSize(11).text("Bill To", rx + 10, blockY + 10);
  doc.fillColor("#111827").font("Helvetica-Bold").fontSize(12).text(safeText(client.company_name || "Customer"), rx + 10, blockY + 26, { width: blockW - 20 });
  doc.font("Helvetica").fontSize(10).fillColor("#374151");
  const toLines = [
    client.address,
    [client.city, client.state, client.pincode].filter(Boolean).join(", ") || null,
    isGstInvoice && client.gstin ? `GSTIN: ${client.gstin}` : null,
    client.phone ? `Phone: ${client.phone}` : null,
    client.state_code || client.state ? `State: ${safeText(client.state_code)} ${safeText(client.state)}`.trim() : null
  ].filter(Boolean);
  y = blockY + 44;
  toLines.forEach((line) => {
    doc.text(line, rx + 10, y, { width: blockW - 20 });
    y += 13;
  });

  doc.y = blockY + blockH + 16;
}

function drawItemsTable(doc, inv) {
  const left = doc.page.margins.left;
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const isGstInvoice = inv.is_gst_invoice !== false;
  const col = isGstInvoice
    ? { no: 22, item: 180, hsn: 55, qty: 38, rate: 52, gst: 42, tax: 56, total: 70 }
    : { no: 22, item: 287, qty: 46, rate: 72, total: 85 };
  let y = doc.y;

  doc.fillColor("#111827").font("Helvetica-Bold").fontSize(12).text("Items", left, y);
  y += 8;
  doc.save();
  doc.rect(left, y, contentWidth, 22).fill(THEME);
  doc.restore();
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(9);

  const headers = isGstInvoice
    ? ["#", "Product", "HSN", "Qty", "Rate", "GST%", "Tax", "Amount"]
    : ["#", "Product", "Qty", "Rate", "Amount"];
  const xs = isGstInvoice
    ? [left, left + col.no, left + col.no + col.item, left + col.no + col.item + col.hsn, left + col.no + col.item + col.hsn + col.qty, left + col.no + col.item + col.hsn + col.qty + col.rate, left + col.no + col.item + col.hsn + col.qty + col.rate + col.gst, left + col.no + col.item + col.hsn + col.qty + col.rate + col.gst + col.tax]
    : [left, left + col.no, left + col.no + col.item, left + col.no + col.item + col.qty, left + col.no + col.item + col.qty + col.rate];
  const ws = isGstInvoice
    ? [col.no, col.item, col.hsn, col.qty, col.rate, col.gst, col.tax, col.total]
    : [col.no, col.item, col.qty, col.rate, col.total];
  headers.forEach((h, i) => doc.text(h, xs[i] + 4, y + 7, { width: ws[i] - 8, align: i < 2 ? "left" : "right" }));
  y += 24;

  doc.font("Helvetica").fontSize(9).fillColor("#111827");
  inv.items.forEach((it, idx) => {
    doc.save();
    doc.rect(left, y, contentWidth, 24).fill(idx % 2 === 0 ? "#f8fafc" : "#ffffff");
    doc.restore();
    const name = `${safeText(it.product?.name || it.description)}${it.product?.pack_size ? ` (${it.product.pack_size})` : ""}`;
    const taxRate = Number(it.gst_rate || 0) + Number(it.cess_rate || 0);
    const values = isGstInvoice
      ? [String(idx + 1), name, safeText(it.hsn_sac_code), money(it.quantity), money(it.unit_price), money(taxRate), money(it.tax_amount), money(it.line_total)]
      : [String(idx + 1), name, money(it.quantity), money(it.unit_price), money(it.line_total)];
    values.forEach((v, i) => doc.text(v, xs[i] + 4, y + 7, { width: ws[i] - 8, align: i < 2 ? "left" : "right", ellipsis: i === 1 }));
    y += 24;
  });
  doc.y = y + 12;
}

function drawSummary(doc, inv) {
  const left = doc.page.margins.left;
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const leftW = 260;
  const rightW = contentWidth - leftW - 14;
  const topY = doc.y;
  const isGstInvoice = inv.is_gst_invoice !== false;

  doc.fillColor("#111827").font("Helvetica-Bold").fontSize(11).text("Charges / Notes", left, topY);
  doc.font("Helvetica").fontSize(9).fillColor("#374151");
  let y = topY + 16;
  if (inv.charges?.length) {
    inv.charges.forEach((c) => {
      doc.text(`• ${c.title || c.label || 'Charge'}${c.type ? ` (${c.type})` : ''}: ₹ ${money(c.amount)}`, left, y, { width: leftW });
      y += 12;
    });
  } else {
    doc.text("• No additional charges.", left, y, { width: leftW });
    y += 12;
  }
  if (inv.notes) {
    y += 6;
    doc.text(`Notes: ${inv.notes}`, left, y, { width: leftW });
    y += 26;
  }
  if (isGstInvoice && Array.isArray(inv.gst_breakup) && inv.gst_breakup.length) {
    doc.font("Helvetica-Bold").fillColor("#111827").text("GST Breakup", left, y, { width: leftW });
    y += 14;
    doc.font("Helvetica").fillColor("#374151");
    inv.gst_breakup.forEach((row) => {
      const label = `${safeText(row.hsn_sac_code) || 'UNSPECIFIED'} @ ${money(row.gst_rate)}%`;
      doc.text(`${label} | Taxable ₹ ${money(row.taxable_value)} | Tax ₹ ${money(row.tax_amount)}`, left, y, { width: leftW });
      y += 12;
    });
  }

  const boxX = left + leftW + 14;
  const boxH = isGstInvoice ? 148 : 98;
  doc.roundedRect(boxX, topY, rightW, boxH, 10).stroke("#d1d5db");
  doc.fillColor(THEME).font("Helvetica-Bold").fontSize(11).text("Total Summary", boxX + 12, topY + 10);
  const rows = isGstInvoice
    ? [
        ["Taxable", money(inv.subtotal)],
        ["Tax", money(inv.tax_subtotal)],
        ["CGST", money(inv.cgst_total)],
        ["SGST", money(inv.sgst_total)],
        ["IGST", money(inv.igst_total)],
        ["Cess", money(inv.cess_total)],
        ["Charges", money(inv.total_charges)],
        ["Round Off", money(inv.round_off)],
        ["Total", money(inv.total)]
      ]
    : [
        ["Subtotal", money(inv.subtotal)],
        ["Charges", money(inv.total_charges)],
        ["Round Off", money(inv.round_off)],
        ["Total", money(inv.total)]
      ];
  let ry = topY + 30;
  rows.forEach(([label, value]) => {
    const isTotal = label === "Total";
    doc.font(isTotal ? "Helvetica-Bold" : "Helvetica").fontSize(isTotal ? 11 : 9).fillColor("#111827");
    doc.text(label, boxX + 12, ry, { width: rightW - 24, align: "left" });
    doc.text(`₹ ${value}`, boxX + 12, ry, { width: rightW - 24, align: "right" });
    ry += isTotal ? 18 : 12;
  });

  doc.y = Math.max(y + 10, topY + boxH + 16);
}

function drawFooter(doc, inv) {
  const left = doc.page.margins.left;
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const bottomY = doc.page.height - doc.page.margins.bottom - 68;
  const isGstInvoice = inv.is_gst_invoice !== false;
  doc.moveTo(left, bottomY).lineTo(left + contentWidth, bottomY).stroke("#e5e7eb");
  doc.fillColor("#6b7280").font("Helvetica").fontSize(9);
  doc.text("Payment Details / Bank Details: configure through your invoice template settings.", left, bottomY + 10, { width: contentWidth });
  doc.text(isGstInvoice ? "This is a system-generated GST-ready invoice document." : "This is a system-generated non-GST invoice document.", left, bottomY + 24, { width: contentWidth });
}

function renderInvoice(doc, inv) {
  drawHeader(doc, inv);
  drawEntityBlocks(doc, inv);
  drawItemsTable(doc, inv);
  drawSummary(doc, inv);
  drawFooter(doc, inv);
  if (inv.kind === "PROFORMA") drawWatermark(doc, "PROFORMA");
}

async function generateInvoicePdfFromData({ inv, outPath }) {
  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 36 });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);
    renderInvoice(doc, inv);
    doc.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
  return inv;
}

async function generateInvoicePdfToFile({ company_id, factory_id, invoiceId, outPath }) {
  const inv = await fetchInvoice(company_id, factory_id, invoiceId);
  if (!inv) {
    const err = new Error("Invoice not found");
    err.statusCode = 404;
    throw err;
  }
  await generateInvoicePdfFromData({ inv, outPath });
  return inv;
}

module.exports = {
  generateInvoicePdfToFile,
  generateInvoicePdfFromData
};
