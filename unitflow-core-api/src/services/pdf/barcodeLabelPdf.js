const PDFDocument = require("pdfkit");
const fs = require("fs");
const prisma = require("../../config/db");

const CODE39 = {
  "0": "nnnwwnwnn", "1": "wnnwnnnnw", "2": "nnwwnnnnw", "3": "wnwwnnnnn", "4": "nnnwwnnnw", "5": "wnnwwnnnn", "6": "nnwwwnnnn", "7": "nnnwnnwnw", "8": "wnnwnnwnn", "9": "nnwwnnwnn",
  "A": "wnnnnwnnw", "B": "nnwnnwnnw", "C": "wnwnnwnnn", "D": "nnnnwwnnw", "E": "wnnnwwnnn", "F": "nnwnwwnnn", "G": "nnnnnwwnw", "H": "wnnnnwwnn", "I": "nnwnnwwnn", "J": "nnnnwwwnn",
  "K": "wnnnnnnww", "L": "nnwnnnnww", "M": "wnwnnnnwn", "N": "nnnnwnnww", "O": "wnnnwnnwn", "P": "nnwnwnnwn", "Q": "nnnnnnwww", "R": "wnnnnnwwn", "S": "nnwnnnwwn", "T": "nnnnwnwwn",
  "U": "wwnnnnnnw", "V": "nwwnnnnnw", "W": "wwwnnnnnn", "X": "nwnnwnnnw", "Y": "wwnnwnnnn", "Z": "nwwnwnnnn", "-": "nwnnnnwnw", ".": "wwnnnnwnn", " ": "nwwnnnwnn", "$": "nwnwnwnnn", "/": "nwnwnnnwn", "+": "nwnnnwnwn", "%": "nnnwnwnwn", "*": "nwnnwnwnn"
};

function sanitizeCode39(value) {
  return (value || "").toString().toUpperCase().replace(/[^0-9A-Z\-\. \$\/\+%]/g, "-");
}

function drawCode39(doc, text, x, y, width, height) {
  const payload = `*${sanitizeCode39(text)}*`;
  const elements = [];
  for (const ch of payload) {
    const pattern = CODE39[ch] || CODE39["-"];
    for (let i = 0; i < pattern.length; i++) {
      elements.push({ black: i % 2 === 0, wide: pattern[i] === "w" });
    }
    elements.push({ black: false, wide: false });
  }

  const narrowCount = elements.reduce((sum, el) => sum + (el.wide ? 0 : 1), 0);
  const wideCount = elements.reduce((sum, el) => sum + (el.wide ? 3 : 0), 0);
  const totalUnits = narrowCount + wideCount;
  const unit = Math.max(1, width / totalUnits);

  let cursor = x;
  doc.save();
  doc.fillColor("#111111");
  for (const el of elements) {
    const barW = unit * (el.wide ? 3 : 1);
    if (el.black) doc.rect(cursor, y, barW, height).fill();
    cursor += barW;
  }
  doc.restore();
}

async function generateProductBarcodeLabelsToFile({ company_id, product_id, outPath }) {
  const product = await prisma.product.findFirst({
    where: { id: product_id, company_id },
    include: {
      category: { select: { name: true } },
      product_barcodes: { where: { is_active: true }, orderBy: [{ is_primary: "desc" }, { code: "asc" }] }
    }
  });
  if (!product) {
    const err = new Error("Product not found");
    err.statusCode = 404;
    throw err;
  }
  const barcodes = product.product_barcodes.length ? product.product_barcodes : [{ code: product.sku || product.id, alias_type: "AUTO", is_primary: true }];

  await new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 28 });
      const stream = fs.createWriteStream(outPath);
      doc.pipe(stream);

      const labelW = 250;
      const labelH = 120;
      const gapX = 18;
      const gapY = 18;
      const cols = 2;

      barcodes.forEach((barcode, idx) => {
        const col = idx % cols;
        const row = Math.floor(idx / cols);
        const x = doc.page.margins.left + col * (labelW + gapX);
        const y = doc.page.margins.top + row * (labelH + gapY);
        if (y + labelH > doc.page.height - doc.page.margins.bottom) {
          doc.addPage();
        }
        const pageRow = Math.floor((idx % 8) / cols);
        const pageX = doc.page.margins.left + col * (labelW + gapX);
        const pageY = doc.page.margins.top + pageRow * (labelH + gapY);

        doc.roundedRect(pageX, pageY, labelW, labelH, 8).strokeColor("#d1d5db").lineWidth(1).stroke();
        doc.font("Helvetica-Bold").fontSize(12).fillColor("#111827").text(product.name, pageX + 10, pageY + 10, { width: labelW - 20, ellipsis: true });
        doc.font("Helvetica").fontSize(9).fillColor("#4b5563").text(`${product.category?.name || "Product"} • ${product.unit}${product.pack_size ? ` • ${product.pack_size}` : ""}`, pageX + 10, pageY + 28, { width: labelW - 20, ellipsis: true });
        drawCode39(doc, barcode.code, pageX + 10, pageY + 46, labelW - 20, 36);
        doc.font("Helvetica-Bold").fontSize(11).fillColor("#111827").text(barcode.code, pageX + 10, pageY + 88, { width: labelW - 20, align: "center" });
        doc.font("Helvetica").fontSize(8).fillColor("#6b7280").text(barcode.alias_type || (barcode.is_primary ? "PRIMARY" : "BARCODE"), pageX + 10, pageY + 103, { width: labelW - 20, align: "center" });
      });

      doc.end();
      stream.on("finish", resolve);
      stream.on("error", reject);
    } catch (err) {
      reject(err);
    }
  });

  return { product };
}

module.exports = { generateProductBarcodeLabelsToFile };
