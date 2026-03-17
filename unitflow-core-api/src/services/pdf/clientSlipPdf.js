const PDFDocument = require("pdfkit");
const prisma = require("../../config/db");

function safeText(v) {
  return v ? String(v) : "";
}

// Small slip intended for label/sticker printing.
// Page height shrinks to fit the actual text — no extra blank paper.
async function generateClientSlipPdfToStream({ company_id, clientId, stream }) {
  const client = await prisma.client.findFirst({
    where: { id: clientId, company_id, is_active: true },
    select: {
      company_name: true,
      address: true,
      city: true,
      state: true,
      pincode: true,
      phone: true,   
      email: true   
    }
  });

  if (!client) {
    const err = new Error("Client not found");
    err.statusCode = 404;
    throw err;
  }

  const slipWidth = 288; // 4 inches at 72 dpi
  const margins = { top: 18, left: 18, right: 18, bottom: 18 };
  const innerW = slipWidth - margins.left - margins.right;

  // ── Measure pass: calculate exact content height using heightOfString ──
  // We create a temporary doc just for measurement (never written to stream).
  const { Writable } = require("stream");
  const measureDoc = new PDFDocument({
    size: [slipWidth, 2000],
    margins
  });
  measureDoc.pipe(new Writable({ write(_, __, cb) { cb(); } }));

  let totalH = margins.top;

  // Title
  measureDoc.font("Helvetica-Bold").fontSize(16);
  totalH += measureDoc.heightOfString(safeText(client.company_name) || "X", { width: innerW });

  // moveDown(0.6) gap
  totalH += 0.6 * measureDoc.currentLineHeight(true);

  measureDoc.font("Helvetica").fontSize(12);

  const addr = safeText(client.address);
  if (addr) totalH += measureDoc.heightOfString(addr, { width: innerW });

  const cityLine = [client.city, client.state, client.pincode].filter(Boolean).join(", ");
  if (cityLine) totalH += measureDoc.heightOfString(cityLine, { width: innerW });

  const phone = safeText(client.phone);
  const email = safeText(client.email);

  if (phone || email) totalH += 0.6 * measureDoc.currentLineHeight(true);
  if (phone) totalH += measureDoc.heightOfString(`Phone: ${phone}`, { width: innerW });
  if (email) totalH += measureDoc.heightOfString(`Email: ${email}`, { width: innerW });

  totalH += margins.bottom;
  measureDoc.end();

  // ── Real pass: create PDF with exact height ──
  const doc = new PDFDocument({
    size: [slipWidth, totalH],
    margins,
    autoFirstPage: true
  });

  doc.pipe(stream);
  renderSlipContent(doc, client, innerW);
  doc.end();
}

function renderSlipContent(doc, client, innerW) {
  // Title: Client name
  doc.font("Helvetica-Bold").fontSize(16).fillColor("#111827");
  doc.text(safeText(client.company_name), { width: innerW, align: "left" });

  doc.moveDown(0.6);
  doc.font("Helvetica").fontSize(12).fillColor("#111827");

  // Address
  const addr = safeText(client.address);
  if (addr) doc.text(addr, { width: innerW });

  const cityLine = [client.city, client.state, client.pincode]
    .filter(Boolean)
    .join(", ");
  if (cityLine) doc.text(cityLine, { width: innerW });

  // Contact info
  const phone = safeText(client.phone);
  const email = safeText(client.email);

  if (phone || email) doc.moveDown(0.6);

  if (phone) doc.text(`Phone: ${phone}`, { width: innerW });
  if (email) doc.text(`Email: ${email}`, { width: innerW });
}

module.exports = { generateClientSlipPdfToStream };