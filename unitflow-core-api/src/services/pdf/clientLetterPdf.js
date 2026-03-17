const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

const THEME = (process.env.PDF_THEME_COLOR || "#022999").trim();

function resolveLogoPath() {
  const p = process.env.INVOICE_LOGO_PATH || "src/assets/unitflow-logo-placeholder.jpeg";
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

function renderTemplate(text, ctx) {
  if (!text) return "";
  return text
    .replace(/\{\{\s*client_name\s*\}\}/gi, ctx.client_name || "")
    .replace(/\{\{\s*client_company\s*\}\}/gi, ctx.client_company || "")
    .replace(/\{\{\s*client_address\s*\}\}/gi, ctx.client_address || "")
    .replace(/\{\{\s*client_city\s*\}\}/gi, ctx.client_city || "")
    .replace(/\{\{\s*client_state\s*\}\}/gi, ctx.client_state || "")
    .replace(/\{\{\s*client_pincode\s*\}\}/gi, ctx.client_pincode || "")
    .replace(/\{\{\s*client_phone\s*\}\}/gi, ctx.client_phone || "")
    .replace(/\{\{\s*client_email\s*\}\}/gi, ctx.client_email || "")
    .replace(/\{\{\s*today\s*\}\}/gi, new Date().toLocaleDateString());
}

function drawLetterHeader(doc, branding, title) {
  const pageWidth = doc.page.width;
  const left = doc.page.margins.left;
  const contentWidth = pageWidth - left - doc.page.margins.right;
  const theme = branding?.themeColor || THEME;

  const headerH = 100;
  const padY = 14;

  // Header strip
  doc.save();
  doc.rect(0, 0, pageWidth, headerH).fill(theme);
  doc.restore();

  // Logo card (square)
  const logoBoxW = 60;
  const logoBoxH = 60;
  const logoBoxX = left;
  const logoBoxY = (headerH - logoBoxH) / 2;

  doc.save();
  doc.roundedRect(logoBoxX, logoBoxY, logoBoxW, logoBoxH, 8).fill("#ffffff");
  doc.restore();

  const logoPath = resolveLogoPath();
  try {
    if (fs.existsSync(logoPath)) {
      doc.image(logoPath, logoBoxX + 4, logoBoxY + 4, {
        fit: [logoBoxW - 8, logoBoxH - 8],
        align: "center",
        valign: "center"
      });
    } else {
      doc.fillColor(theme).font("Helvetica-Bold").fontSize(10).text("LOGO", logoBoxX + 16, logoBoxY + 22);
    }
  } catch (e) {
    doc.fillColor(theme).font("Helvetica-Bold").fontSize(10).text("LOGO", logoBoxX + 16, logoBoxY + 22);
  }

  // Right column – company info + title
  const rightColX = logoBoxX + logoBoxW + 18;
  const rightColW = left + contentWidth - rightColX;

  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(16);
  doc.text(branding?.companyName || "", rightColX, padY + 4, { width: rightColW, align: "right" });

  if (branding?.companyAddress) {
    doc.font("Helvetica").fontSize(9).fillColor("#eaf6fb");
    doc.text(branding.companyAddress, rightColX, padY + 26, { width: rightColW, align: "right" });
  }

  // Title at bottom-right of header
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(14);
  doc.text(title || "Letter", rightColX, headerH - padY - 18, { width: rightColW, align: "right" });

  doc.y = headerH + 20;
}

async function generateClientLetterPdfToStream({ stream, branding, title, body, ctx }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 50 });
      doc.on("error", reject);
      doc.pipe(stream);

      drawLetterHeader(doc, branding, title);

      doc.moveDown(1);

      const renderedBody = renderTemplate(body, ctx);
      doc.fontSize(11).fillColor("#111").text(renderedBody, { align: "left", lineGap: 4 });

      doc.moveDown(2);
      doc.fontSize(10).fillColor("#444").text(`Generated on ${new Date().toLocaleString()}`, { align: "right" });

      doc.end();
      stream.on("finish", resolve);
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = {
  generateClientLetterPdfToStream
};
