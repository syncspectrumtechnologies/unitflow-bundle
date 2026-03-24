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

async function fetchChallan(company_id, factory_id, challanId) {
  return prisma.deliveryChallan.findFirst({
    where: { id: challanId, company_id, factory_id, is_active: true },
    include: {
      company: true,
      factory: true,
      client: true,
      order: true,
      sales_company: true,
      items: { include: { product: true } }
    }
  });
}

async function generateDeliveryChallanPdfToFile({ company_id, factory_id, challanId, outPath }) {
  const challan = await fetchChallan(company_id, factory_id, challanId);
  if (!challan) {
    const err = new Error("Delivery challan not found");
    err.statusCode = 404;
    throw err;
  }

  await new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 36 });
      const stream = fs.createWriteStream(outPath);
      doc.pipe(stream);

      const left = doc.page.margins.left;
      const right = doc.page.margins.right;
      const pageWidth = doc.page.width;
      const contentWidth = pageWidth - left - right;
      const headerH = 100;

      doc.save();
      doc.rect(0, 0, pageWidth, headerH).fill(THEME);
      doc.restore();

      const logoPath = resolveLogoPath();
      if (fs.existsSync(logoPath)) {
        doc.save();
        doc.roundedRect(left, 20, 60, 60, 8).fill("#ffffff");
        doc.restore();
        doc.image(logoPath, left + 4, 24, { fit: [52, 52], align: "center", valign: "center" });
      }

      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(18);
      doc.text("DELIVERY CHALLAN", left + 80, 18, { width: contentWidth - 80, align: "right" });
      doc.font("Helvetica").fontSize(10).fillColor("#eaf6fb");
      const meta = [
        `Challan No: ${challan.challan_no}`,
        `Date: ${new Date(challan.issue_date).toLocaleDateString()}`,
        `Status: ${challan.status}`,
        `Reason: ${challan.reason}`,
        challan.order?.order_no ? `Order Ref: ${challan.order.order_no}` : null,
        challan.place_of_supply_code ? `Place of Supply: ${challan.place_of_supply_code}${challan.place_of_supply_state ? ` / ${challan.place_of_supply_state}` : ""}` : null
      ].filter(Boolean);
      let metaY = 40;
      for (const line of meta) {
        doc.text(line, left + 80, metaY, { width: contentWidth - 80, align: "right" });
        metaY += 12;
      }
      doc.y = headerH + 16;

      const entity = challan.sales_company || challan.company || {};
      const client = challan.client || {};
      const blockW = (contentWidth - 14) / 2;
      const blockH = 95;
      doc.roundedRect(left, doc.y, blockW, blockH, 8).stroke("#d1d5db");
      doc.roundedRect(left + blockW + 14, doc.y, blockW, blockH, 8).stroke("#d1d5db");
      doc.fillColor(THEME).font("Helvetica-Bold").fontSize(11).text("From", left + 10, doc.y + 10);
      doc.fillColor("#111827").font("Helvetica-Bold").fontSize(12).text(safeText(entity.legal_name || entity.name || challan.company?.name), left + 10, doc.y + 26, { width: blockW - 20 });
      doc.font("Helvetica").fontSize(10).fillColor("#374151");
      doc.text(safeText(entity.address || challan.factory?.address || challan.company?.address), left + 10, doc.y + 44, { width: blockW - 20 });
      doc.text(entity.gstin ? `GSTIN: ${entity.gstin}` : "GSTIN: ____________", left + 10, doc.y + 58, { width: blockW - 20 });
      doc.text(entity.phone ? `Phone: ${entity.phone}` : "", left + 10, doc.y + 72, { width: blockW - 20 });

      const rightX = left + blockW + 14;
      doc.fillColor(THEME).font("Helvetica-Bold").fontSize(11).text("To", rightX + 10, doc.y + 10);
      doc.fillColor("#111827").font("Helvetica-Bold").fontSize(12).text(safeText(client.company_name || "Customer"), rightX + 10, doc.y + 26, { width: blockW - 20 });
      doc.font("Helvetica").fontSize(10).fillColor("#374151");
      doc.text(safeText(client.address), rightX + 10, doc.y + 44, { width: blockW - 20 });
      doc.text(client.gstin ? `GSTIN: ${client.gstin}` : "", rightX + 10, doc.y + 58, { width: blockW - 20 });
      doc.text(client.phone ? `Phone: ${client.phone}` : "", rightX + 10, doc.y + 72, { width: blockW - 20 });

      doc.y += blockH + 18;
      const col = { no: 30, product: contentWidth - (30 + 80 + 80), hsn: 80, qty: 80 };
      const startY = doc.y;
      doc.save();
      doc.rect(left, startY, contentWidth, 22).fill(THEME);
      doc.restore();
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(10);
      doc.text("#", left + 8, startY + 7, { width: col.no - 8 });
      doc.text("Product", left + col.no + 8, startY + 7, { width: col.product - 16 });
      doc.text("HSN/SAC", left + col.no + col.product + 4, startY + 7, { width: col.hsn - 8, align: "right" });
      doc.text("Qty", left + col.no + col.product + col.hsn, startY + 7, { width: col.qty - 8, align: "right" });
      let y = startY + 24;
      doc.font("Helvetica").fontSize(10).fillColor("#111827");
      challan.items.forEach((item, index) => {
        doc.save();
        doc.rect(left, y, contentWidth, 20).fill(index % 2 === 0 ? "#f8fafc" : "#ffffff");
        doc.restore();
        doc.text(String(index + 1), left + 8, y + 5, { width: col.no - 8 });
        doc.text(safeText(item.product?.name), left + col.no + 8, y + 5, { width: col.product - 16, ellipsis: true });
        doc.text(safeText(item.product?.hsn_sac_code), left + col.no + col.product + 4, y + 5, { width: col.hsn - 8, align: "right" });
        doc.text(`${money(item.quantity)} ${safeText(item.product?.unit)}`.trim(), left + col.no + col.product + col.hsn, y + 5, { width: col.qty - 8, align: "right" });
        y += 20;
      });

      doc.y = y + 18;
      if (challan.notes) {
        doc.font("Helvetica-Bold").fillColor("#111827").text("Notes", left, doc.y);
        doc.font("Helvetica").fillColor("#374151").text(challan.notes, left, doc.y + 14, { width: contentWidth });
        doc.y += 40;
      }

      doc.moveDown(3);
      doc.fillColor("#6b7280").font("Helvetica").fontSize(9);
      doc.text("This is a system-generated delivery challan.", left, doc.page.height - 70, { width: contentWidth });
      doc.text("For transport/stock movement purposes only; tax invoice should be issued separately where applicable.", left, doc.page.height - 56, { width: contentWidth });

      doc.end();
      stream.on("finish", resolve);
      stream.on("error", reject);
    } catch (err) {
      reject(err);
    }
  });

  return challan;
}

module.exports = { generateDeliveryChallanPdfToFile };
