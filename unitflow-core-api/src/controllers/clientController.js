const prisma = require("../config/db");
const logActivity = require("../utils/activityLogger");
const { factoryWhere } = require("../utils/factoryScope");
const { orderVisibilityWhere } = require("../utils/factoryVisibility");
const { PassThrough } = require("stream");
const { generateClientLetterPdfToStream } = require("../services/pdf/clientLetterPdf");
const { generateClientSlipPdfToStream } = require("../services/pdf/clientSlipPdf");
const { logQueued, sendTransactionalEmail } = require("../services/messageDispatchService");
const { getPagination, buildPaginationMeta } = require("../utils/pagination");

exports.createClient = async (req, res) => {
  try {
    const company_id = req.user.company_id;

    const {
      company_name,
      gstin,
      phone,
      email,
      address,
      city,
      state,
      pincode
    } = req.body;

    if (!company_name) {
      return res.status(400).json({ message: "company_name is required" });
    }

    const existing = await prisma.client.findFirst({
      where: {
        company_id,
        company_name: company_name.trim(),
        is_active: true
      }
    });

    if (existing) {
      return res.status(409).json({ message: "Client already exists" });
    }

    const client = await prisma.client.create({
      data: {
        company_id,
        company_name: company_name.trim(),
        gstin: gstin?.trim() || null,
        phone: phone?.trim() || null,
        email: email?.trim() || null,
        address: address?.trim() || null,
        city: city?.trim() || null,
        state: state?.trim() || null,
        pincode: pincode?.trim() || null,
        is_active: true
      }
    });

    await logActivity({
      company_id,
      user_id: req.user.id,
      action: "CLIENT_CREATED",
      entity_type: "client",
      entity_id: client.id,
      new_value: client,
      ip: req.ip,
      user_agent: req.headers["user-agent"]
    });

    return res.status(201).json(client);
  } catch (err) {
    console.error("createClient error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getClients = async (req, res) => {
  try {
    const company_id = req.user.company_id;

    const q = (req.query.q || "").toString().trim();
    const product_id = (req.query.product_id || "").toString().trim();
    const category_id = (req.query.category_id || "").toString().trim();

    const where = { company_id, is_active: true };

    if (q) {
      where.OR = [
        { company_name: { contains: q, mode: "insensitive" } },
        { phone: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } }
      ];
    }

    // Filter clients by product they deal with (ClientProduct mapping)
    if (product_id || category_id) {
      where.products = {
        some: {
          is_active: true,
          ...(product_id ? { product_id } : {}),
          ...(category_id ? { product: { category_id } } : {})
        }
      };
    }

    const pagination = getPagination(req, { defaultPageSize: 25, maxPageSize: 100 });
    const query = {
      where,
      orderBy: [{ updated_at: "desc" }, { id: "desc" }],
      select: {
        id: true,
        company_name: true,
        phone: true,
        email: true,
        city: true,
        state: true,
        is_active: true,
        created_at: true,
        updated_at: true,
        _count: {
          select: { contacts: true, products: true, orders: true, invoices: true }
        }
      }
    };
    if (pagination.enabled) {
      query.skip = pagination.skip;
      query.take = pagination.take;
    }

    const [clients, total] = await Promise.all([
      prisma.client.findMany(query),
      pagination.enabled && pagination.include_total ? prisma.client.count({ where }) : Promise.resolve(null)
    ]);

    if (!pagination.enabled) return res.json(clients);

    return res.json({
      items: clients,
      pagination: buildPaginationMeta({ page: pagination.page, page_size: pagination.page_size, total: total ?? clients.length })
    });
  } catch (err) {
    console.error("getClients error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};


exports.getClientById = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const { clientId } = req.params;

    const client = await prisma.client.findFirst({
      where: { id: clientId, company_id },
      include: {
        contacts: {
          orderBy: { updated_at: "desc" }
        },
        products: {
          where: { is_active: true },
          include: {
            product: {
              select: {
                id: true,
                name: true,
                unit: true,
                pack_size: true,
                category: { select: { id: true, name: true } }
              }
            }
          }
        },
        orders: {
          orderBy: { created_at: "desc" },
          take: 25,
          select: {
            id: true,
            order_no: true,
            status: true,
            order_date: true,
            total: true,
            factory_id: true
          }
        },
        invoices: {
          orderBy: { created_at: "desc" },
          take: 25,
          select: {
            id: true,
            invoice_no: true,
            kind: true,
            status: true,
            issue_date: true,
            total: true,
            factory_id: true
          }
        }
      }
    });

    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }

    return res.json(client);
  } catch (err) {
    console.error("getClientById error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.updateClient = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const { clientId } = req.params;

    const existing = await prisma.client.findFirst({
      where: { id: clientId, company_id }
    });

    if (!existing) {
      return res.status(404).json({ message: "Client not found" });
    }

    const {
      company_name,
      gstin,
      phone,
      email,
      address,
      city,
      state,
      pincode,
      is_active
    } = req.body;

    if (company_name && company_name.trim().length === 0) {
      return res.status(400).json({ message: "company_name cannot be empty" });
    }

    // if company_name changed, ensure uniqueness
    if (company_name && company_name.trim() !== existing.company_name) {
      const dup = await prisma.client.findFirst({
        where: {
          company_id,
          company_name: company_name.trim(),
          id: { not: clientId }
        }
      });
      if (dup) {
        return res.status(409).json({ message: "Another client with same name exists" });
      }
    }

    const updated = await prisma.client.update({
      where: { id: clientId },
      data: {
        company_name: company_name ? company_name.trim() : undefined,
        gstin: gstin !== undefined ? (gstin?.trim() || null) : undefined,
        phone: phone !== undefined ? (phone?.trim() || null) : undefined,
        email: email !== undefined ? (email?.trim() || null) : undefined,
        address: address !== undefined ? (address?.trim() || null) : undefined,
        city: city !== undefined ? (city?.trim() || null) : undefined,
        state: state !== undefined ? (state?.trim() || null) : undefined,
        pincode: pincode !== undefined ? (pincode?.trim() || null) : undefined,
        is_active: typeof is_active === "boolean" ? is_active : undefined
      }
    });

    await logActivity({
      company_id,
      user_id: req.user.id,
      action: "CLIENT_UPDATED",
      entity_type: "client",
      entity_id: clientId,
      old_value: existing,
      new_value: updated,
      ip: req.ip,
      user_agent: req.headers["user-agent"]
    });

    return res.json(updated);
  } catch (err) {
    console.error("updateClient error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.deleteClient = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const { clientId } = req.params;

    const existing = await prisma.client.findFirst({
      where: { id: clientId, company_id }
    });

    if (!existing) {
      return res.status(404).json({ message: "Client not found" });
    }

    // Soft delete
    const updated = await prisma.client.update({
      where: { id: clientId },
      data: { is_active: false }
    });

    await logActivity({
      company_id,
      user_id: req.user.id,
      action: "CLIENT_DELETED",
      entity_type: "client",
      entity_id: clientId,
      old_value: { is_active: existing.is_active },
      new_value: { is_active: false },
      ip: req.ip,
      user_agent: req.headers["user-agent"]
    });

    return res.json({ message: "Client disabled (soft deleted)" });
  } catch (err) {
    console.error("deleteClient error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getClientProducts = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const { clientId } = req.params;

    const client = await prisma.client.findFirst({
      where: { id: clientId, company_id, is_active: true },
      select: { id: true }
    });

    if (!client) return res.status(404).json({ message: "Client not found" });

    const products = await prisma.clientProduct.findMany({
      where: { company_id, client_id: clientId, is_active: true },
      orderBy: { updated_at: "desc" },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            unit: true,
            pack_size: true,
            sku: true,
            category: { select: { id: true, name: true } }
          }
        }
      }
    });

    return res.json(products);
  } catch (err) {
    console.error("getClientProducts error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// Generates a custom letter PDF with auto-filled client fields.
exports.generateClientLetterPdf = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const { clientId } = req.params;

    const client = await prisma.client.findFirst({
      where: { id: clientId, company_id, is_active: true },
      include: { contacts: { where: { is_active: true }, orderBy: { created_at: "asc" } } }
    });
    if (!client) return res.status(404).json({ message: "Client not found" });

    const { title, body } = req.body || {};
    const defaultBody =
      "Date: {{today}}\n\nTo,\n{{client_company}}\n{{client_address}}\n{{client_city}}, {{client_state}} {{client_pincode}}\n\nSubject: " +
      (title || "") +
      "\n\nDear {{client_name}},\n\n" +
      "(Write your content here...)\n\n" +
      "Sincerely,\n";

    const ctx = {
      client_name: client.company_name,
      client_company: client.company_name,
      client_address: client.address || "",
      client_city: client.city || "",
      client_state: client.state || "",
      client_pincode: client.pincode || "",
      client_phone: client.phone || "",
      client_email: client.email || ""
    };

    const stream = new PassThrough();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="client-letter-${clientId}.pdf"`);
    stream.pipe(res);

    await generateClientLetterPdfToStream({
      stream,
      branding: {
        companyName: process.env.BRAND_NAME || "UnitFlow",
        companyAddress: process.env.BRAND_ADDRESS || "",
        themeColor: process.env.PDF_THEME_COLOR || "#2596be"
      },
      title: title || "Letter",
      body: (body || defaultBody).toString(),
      ctx
    });
  } catch (err) {
    console.error("generateClientLetterPdf error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// GET /clients/:clientId/orders
// Returns complete order history for a client (factory-scoped view) including items, charges and linked invoices.
exports.getClientOrderHistory = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const fw = orderVisibilityWhere(req);
    // factoryAccessMiddleware guarantees a factory scope (single or ALL) for this endpoint.
    const { clientId } = req.params;

    const client = await prisma.client.findFirst({
      where: { id: clientId, company_id, is_active: true },
      select: { id: true, company_name: true }
    });
    if (!client) return res.status(404).json({ message: "Client not found" });

    const orders = await prisma.order.findMany({
      where: { company_id, ...fw, client_id: clientId, is_active: true },
      orderBy: { order_date: "desc" },
      include: {
        items: true,
        charges: true,
        status_history: { orderBy: { created_at: "asc" } },
        factory: { select: { id: true, name: true } },
        invoices: {
          where: { is_active: true },
          include: {
            items: true,
            charges: true,
            status_history: { orderBy: { created_at: "asc" } }
          }
        }
      }
    });

    return res.json({ client, count: orders.length, orders });
  } catch (err) {
    console.error("getClientOrderHistory error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// GET /clients/inactive?days=45
// Lists clients (company-wide) with no orders in the given period (factory optional via ?factory_id).
exports.getInactiveClients = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const days = Math.max(1, Number(req.query.days || 45));
    const factory_id = (req.query.factory_id || "").toString().trim() || null;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const pagination = getPagination(req, { defaultPageSize: 25, maxPageSize: 100 });

    const clients = await prisma.client.findMany({
      where: { company_id, is_active: true },
      select: { id: true, company_name: true, email: true, phone: true }
    });

    const ordersWhere = {
      company_id,
      is_active: true,
      ...(factory_id ? orderVisibilityWhere({ factory_id }) : {})
    };

    const lastOrderDates = await prisma.order.groupBy({
      by: ["client_id"],
      where: ordersWhere,
      _max: { order_date: true }
    });

    const lastOrderMap = new Map(lastOrderDates.map((row) => [row.client_id, row._max.order_date]));

    const lastOrderRows = lastOrderDates.length
      ? await prisma.order.findMany({
          where: {
            company_id,
            is_active: true,
            client_id: { in: lastOrderDates.map((row) => row.client_id) }
          },
          distinct: ["client_id"],
          orderBy: [{ client_id: "asc" }, { order_date: "desc" }],
          select: { client_id: true, order_date: true, order_no: true, factory_id: true }
        })
      : [];

    const lastOrderDetailMap = new Map(lastOrderRows.map((row) => [row.client_id, row]));

    const results = clients
      .map((c) => {
        const lastDate = lastOrderMap.get(c.id) || null;
        if (lastDate && new Date(lastDate) >= cutoff) return null;
        const lastOrder = lastOrderDetailMap.get(c.id) || null;
        const daysSince = lastDate ? Math.floor((Date.now() - new Date(lastDate).getTime()) / (24 * 3600 * 1000)) : null;
        return {
          client_id: c.id,
          company_name: c.company_name,
          last_order_date: lastDate,
          last_order_no: lastOrder?.order_no || null,
          last_order_factory_id: lastOrder?.factory_id || null,
          days_since_last_order: daysSince,
          eligible: true
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        const aTime = a.last_order_date ? new Date(a.last_order_date).getTime() : 0;
        const bTime = b.last_order_date ? new Date(b.last_order_date).getTime() : 0;
        return aTime - bTime;
      });

    if (!pagination.enabled) {
      return res.json({ days, factory_id, count: results.length, clients: results });
    }

    const startIdx = pagination.skip;
    const items = results.slice(startIdx, startIdx + pagination.take);
    return res.json({
      days,
      factory_id,
      count: results.length,
      clients: items,
      pagination: buildPaginationMeta({ page: pagination.page, page_size: pagination.page_size, total: results.length })
    });
  } catch (err) {
    console.error("getInactiveClients error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// POST /clients/:clientId/re-engage
// If no orders in last 45 days, generates (and optionally sends) a draft email.
exports.reEngageClient = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const { clientId } = req.params;
    const { send = false, subject, message, to_email } = req.body || {};

    const client = await prisma.client.findFirst({
      where: { id: clientId, company_id, is_active: true },
      include: {
        contacts: { where: { is_active: true }, orderBy: { created_at: "asc" } },
        orders: { orderBy: { order_date: "desc" }, take: 1, select: { order_date: true, order_no: true } }
      }
    });
    if (!client) return res.status(404).json({ message: "Client not found" });

    const lastOrderDate = client.orders?.[0]?.order_date || null;
    const daysSince = lastOrderDate ? Math.floor((Date.now() - new Date(lastOrderDate).getTime()) / (24 * 3600 * 1000)) : null;
    const eligible = !lastOrderDate || daysSince >= 45;

    const draftedSubject = subject || `Quick check-in - ${process.env.BRAND_NAME || "UnitFlow"}`;
    const draftedMessage =
      message ||
      `Hello ${client.company_name},\n\nWe noticed we haven't received an order from you in the last ${daysSince ?? "few"} days.` +
        `${lastOrderDate ? ` Your last order was on ${new Date(lastOrderDate).toLocaleDateString()}.` : ""}` +
        "\n\nIf you need any assistance, updated pricing, or want to place a new order, just reply to this email and we'll help immediately.\n\nThanks,\n" +
        (process.env.BRAND_NAME || "UnitFlow");

    const defaultEmail = client.contacts?.find(c => c.email)?.email || client.email || null;
    const email = to_email || defaultEmail;

    if (!send) {
      return res.json({
        eligible,
        days_since_last_order: daysSince,
        to_email: email,
        subject: draftedSubject,
        message: draftedMessage
      });
    }

    if (!eligible) {
      return res.status(400).json({ message: "Client has ordered within last 45 days", days_since_last_order: daysSince });
    }
    if (!email) {
      return res.status(400).json({ message: "No client email found. Provide to_email." });
    }

    const log = await logQueued({
      company_id,
      channel: "EMAIL",
      to: email,
      created_by: req.user.id,
      client_id: clientId,
      payload: { reason: "RE_ENGAGE", days_since_last_order: daysSince }
    });

    const resp = await sendTransactionalEmail({
      toEmail: email,
      toName: null,
      subject: draftedSubject,
      html: `<pre style="font-family:inherit">${draftedMessage}</pre>`,
      logId: log.id
    });

    return res.json({ ok: true, eligible, log_id: log.id, provider: resp });
  } catch (err) {
    console.error("reEngageClient error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// POST /clients/:clientId/letter.pdf
// Generate a custom letter PDF with client placeholders auto-filled.
exports.generateClientLetterPdf = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const { clientId } = req.params;
    const { title, body } = req.body || {};

    const client = await prisma.client.findFirst({
      where: { id: clientId, company_id, is_active: true },
      include: { contacts: { where: { is_active: true }, orderBy: { created_at: "asc" } } }
    });
    if (!client) return res.status(404).json({ message: "Client not found" });

    const primaryContact = client.contacts?.[0] || null;
    const ctx = {
      client_company: client.company_name,
      client_name: primaryContact?.name || client.company_name,
      client_address: client.address || "",
      client_city: client.city || "",
      client_state: client.state || "",
      client_pincode: client.pincode || "",
      client_phone: primaryContact?.phone || client.phone || "",
      client_email: primaryContact?.email || client.email || ""
    };

    const stream = new PassThrough();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="letter-${client.company_name.replace(/\s+/g, "-")}.pdf"`);
    stream.pipe(res);

    await generateClientLetterPdfToStream({
      stream,
      branding: {
        companyName: process.env.PDF_BRAND_NAME || "UnitFlow",
        companyAddress: process.env.PDF_BRAND_ADDRESS || "",
        themeColor: process.env.PDF_THEME_COLOR || process.env.PDF_THEME || "#2596be"
      },
      title: title || "Letter",
      body: body || "Dear {{client_name}},\n\nThis is a letter regarding our business relationship.\n\nSincerely,\nUnitFlow",
      ctx
    });
  } catch (err) {
    console.error("generateClientLetterPdf error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// GET /clients/:clientId/slip.pdf
// Small slip with only client name + address (for printing & pasting on orders).
exports.getClientSlipPdf = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const { clientId } = req.params;

    const stream = new PassThrough();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="client-slip-${clientId}.pdf"`);
    stream.pipe(res);

    await generateClientSlipPdfToStream({ company_id, clientId, stream });
  } catch (err) {
    console.error("getClientSlipPdf error:", err);
    return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
  }
};

// POST /clients/:clientId/re-engage
// If client has no orders in last 45 days, returns a draft email and can send it.
