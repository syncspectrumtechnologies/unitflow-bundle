const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const prisma = require("../../config/db");

const THEME = (process.env.PDF_THEME_COLOR || "#022999").trim();

function resolveLogoPath() {
  const p = process.env.INVOICE_LOGO_PATH || "src/assets/unitflow-logo-placeholder.jpeg";
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

function safeText(v) {
  return v ? String(v) : "";
}

function money(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? n.toFixed(2) : "0.00";
}

async function generatePurchasePdfToFile({ company_id, factory_id, purchaseId, outPath }) {
  const purchase = await prisma.purchase.findFirst({
    where: { id: purchaseId, company_id, factory_id, is_active: true },
    include: {
      items: { include: { product: true } },
      charges: true,
      factory: true,
      company: true,
      receipts: { include: { items: true } },
      returns: { include: { items: true } }
    }
  });
  if (!purchase) {
    const err = new Error("Purchase not found");
    err.statusCode = 404;
    throw err;
  }

  await new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 36 });
      const stream = fs.createWriteStream(outPath);
      doc.pipe(stream);

      const left = doc.page.margins.left;
      const pageWidth = doc.page.width;
      const contentWidth = pageWidth - doc.page.margins.left - doc.page.margins.right;
      const headerH = 110;

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

      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(18);
      doc.text("PURCHASE ORDER", left + 80, 18, { width: contentWidth - 80, align: "right" });
      doc.font("Helvetica").fontSize(10).fillColor("#eaf6fb");
      const meta = [
        `PO No: ${purchase.purchase_no}`,
        `Date: ${new Date(purchase.purchase_date).toLocaleDateString()}`,
        `Status: ${purchase.status}`,
        purchase.supply_type ? `Supply Type: ${purchase.supply_type}` : null,
        purchase.vendor_state_code ? `Vendor State: ${purchase.vendor_state_code}${purchase.vendor_state ? ` / ${purchase.vendor_state}` : ""}` : null,
        `Factory: ${safeText(purchase.factory?.name)}`
      ].filter(Boolean);
      let my = 38;
      for (const line of meta) {
        doc.text(line, left + 80, my, { width: contentWidth - 80, align: "right" });
        my += 12;
      }
      doc.y = headerH + 14;

      const blockY = doc.y;
      const blockW = contentWidth;
      const blockH = 100;
      doc.roundedRect(left, blockY, blockW, blockH, 8).stroke("#d1d5db");
      doc.fillColor(THEME).font("Helvetica-Bold").fontSize(11).text("Vendor", left + 10, blockY + 10);
      doc.fillColor("#111827").font("Helvetica-Bold").fontSize(12).text(safeText(purchase.vendor_name), left + 10, blockY + 28, { width: blockW - 20 });
      doc.font("Helvetica").fontSize(10).fillColor("#374151");
      const vendorLines = [
        purchase.vendor_address,
        purchase.vendor_gstin ? `GSTIN: ${purchase.vendor_gstin}` : null,
        purchase.vendor_gst_registration_type ? `Registration: ${purchase.vendor_gst_registration_type}` : null,
        purchase.vendor_phone ? `Phone: ${purchase.vendor_phone}` : null,
        purchase.vendor_email ? `Email: ${purchase.vendor_email}` : null
      ].filter(Boolean);
      let vy = blockY + 46;
      vendorLines.forEach((line) => {
        doc.text(line, left + 10, vy, { width: blockW - 20 });
        vy += 13;
      });
      doc.y = blockY + blockH + 16;

      const col = { no: 22, desc: 160, hsn: 50, qty: 42, rec: 42, rate: 48, gst: 42, amount: 60 };
      let y = doc.y;
      doc.fillColor("#111827").font("Helvetica-Bold").fontSize(12).text("Items", left, y);
      y += 8;
      doc.save();
      doc.rect(left, y, contentWidth, 22).fill(THEME);
      doc.restore();
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(9);
      const headers = ["#", "Description", "HSN", "Qty", "Recvd", "Rate", "GST%", "Amount"];
      const xs = [left, left + col.no, left + col.no + col.desc, left + col.no + col.desc + col.hsn, left + col.no + col.desc + col.hsn + col.qty, left + col.no + col.desc + col.hsn + col.qty + col.rec, left + col.no + col.desc + col.hsn + col.qty + col.rec + col.rate, left + col.no + col.desc + col.hsn + col.qty + col.rec + col.rate + col.gst];
      const ws = [col.no, col.desc, col.hsn, col.qty, col.rec, col.rate, col.gst, col.amount];
      headers.forEach((h, i) => doc.text(h, xs[i] + 4, y + 7, { width: ws[i] - 8, align: i < 2 ? "left" : "right" }));
      y += 24;
      doc.font("Helvetica").fontSize(9).fillColor("#111827");
      purchase.items.forEach((it, idx) => {
        doc.save();
        doc.rect(left, y, contentWidth, 24).fill(idx % 2 === 0 ? "#f8fafc" : "#ffffff");
        doc.restore();
        const taxRate = Number(it.gst_rate || 0) + Number(it.cess_rate || 0);
        const values = [
          String(idx + 1),
          safeText(it.description || it.product?.name),
          safeText(it.hsn_sac_code),
          money(it.quantity),
          money(it.received_quantity),
          money(it.unit_price),
          money(taxRate),
          money(it.line_total)
        ];
        values.forEach((v, i) => doc.text(v, xs[i] + 4, y + 7, { width: ws[i] - 8, align: i < 2 ? "left" : "right", ellipsis: i === 1 }));
        y += 24;
      });
      doc.y = y + 12;

      const leftW = 260;
      const rightW = contentWidth - leftW - 14;
      const topY = doc.y;
      doc.fillColor("#111827").font("Helvetica-Bold").fontSize(11).text("Charges / Notes", left, topY);
      doc.font("Helvetica").fontSize(9).fillColor("#374151");
      let cy = topY + 16;
      if (purchase.charges.length) {
        purchase.charges.forEach((c) => {
          doc.text(`• ${c.label}${c.type ? ` (${c.type})` : ""}: ₹ ${money(c.amount)}`, left, cy, { width: leftW });
          cy += 12;
        });
      } else {
        doc.text("• No additional charges.", left, cy, { width: leftW });
        cy += 12;
      }
      if (purchase.notes) {
        cy += 6;
        doc.text(`Notes: ${purchase.notes}`, left, cy, { width: leftW });
        cy += 24;
      }
      doc.font("Helvetica-Bold").fillColor("#111827").text(`GRNs: ${purchase.receipts.length} | Returns: ${purchase.returns.length}`, left, cy, { width: leftW });
      cy += 14;
      if (Array.isArray(purchase.gst_breakup) && purchase.gst_breakup.length) {
        doc.font("Helvetica-Bold").text("GST Breakup", left, cy, { width: leftW });
        cy += 14;
        doc.font("Helvetica").fillColor("#374151");
        purchase.gst_breakup.forEach((row) => {
          doc.text(`${safeText(row.hsn_sac_code) || 'UNSPECIFIED'} @ ${money(row.gst_rate)}% | Taxable ₹ ${money(row.taxable_value)} | Tax ₹ ${money(row.tax_amount)}`, left, cy, { width: leftW });
          cy += 12;
        });
      }

      doc.roundedRect(left + leftW + 14, topY, rightW, 148, 10).stroke("#d1d5db");
      doc.fillColor(THEME).font("Helvetica-Bold").fontSize(11).text("Total Summary", left + leftW + 26, topY + 10);
      const rows = [
        ["Taxable", purchase.subtotal],
        ["Tax", purchase.tax_subtotal],
        ["CGST", purchase.cgst_total],
        ["SGST", purchase.sgst_total],
        ["IGST", purchase.igst_total],
        ["Cess", purchase.cess_total],
        ["Charges", purchase.total_charges],
        ["Round Off", purchase.round_off],
        ["Total", purchase.total]
      ];
      let ry = topY + 30;
      rows.forEach(([label, value]) => {
        const isTotal = label === "Total";
        doc.font(isTotal ? "Helvetica-Bold" : "Helvetica").fontSize(isTotal ? 11 : 9).fillColor("#111827");
        doc.text(label, left + leftW + 26, ry, { width: rightW - 24, align: "left" });
        doc.text(`₹ ${money(value)}`, left + leftW + 26, ry, { width: rightW - 24, align: "right" });
        ry += isTotal ? 18 : 12;
      });

      const footerY = doc.page.height - doc.page.margins.bottom - 60;
      doc.moveTo(left, footerY).lineTo(left + contentWidth, footerY).stroke("#e5e7eb");
      doc.fillColor("#6b7280").font("Helvetica").fontSize(9);
      doc.text("This is a system-generated GST-ready purchase document.", left, footerY + 10, { width: contentWidth });
      doc.text("Values captured here are structured for future GST return / reconciliation workflows.", left, footerY + 24, { width: contentWidth });

      doc.end();
      stream.on("finish", resolve);
      stream.on("error", reject);
    } catch (e) {
      reject(e);
    }
  });

  return { purchase };
}

module.exports = {
  generatePurchasePdfToFile
};
