const prisma = require("../config/db");
const { orderVisibilityWhere, invoiceVisibilityWhere } = require("../utils/factoryVisibility");
const { dispatchCampaign, enqueueCampaignDispatch } = require("../services/messageDispatchService");
const { getPagination, buildPaginationMeta } = require("../utils/pagination");

exports.createCampaign = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const { name, channel, template_id, purpose, factory_id, recipients } = req.body;

    if (!name) return res.status(400).json({ message: "name is required" });
    if (!channel || !["EMAIL", "WHATSAPP"].includes(channel)) {
      return res.status(400).json({ message: "channel must be EMAIL or WHATSAPP" });
    }

    const campaign = await prisma.messageCampaign.create({
      data: {
        company_id,
        name,
        channel,
        template_id: template_id || null,
        purpose: purpose || null,
        factory_id: factory_id || null,
        created_by: req.user.id
      }
    });

    // recipients: [{ to_email?, to_phone?, client_id?, contact_id?, payload? }]
    if (Array.isArray(recipients) && recipients.length) {
      const rows = recipients.map((r) => ({
        company_id,
        campaign_id: campaign.id,
        client_id: r.client_id || null,
        contact_id: r.contact_id || null,
        to_email: r.to_email || null,
        to_phone: r.to_phone || null,
        payload: r.payload || null
      }));

      await prisma.messageRecipient.createMany({ data: rows });
    }

    return res.status(201).json(campaign);
  } catch (err) {
    console.error("createCampaign error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.dispatchCampaign = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const { id } = req.params;

    const asyncMode = req.query.async === "true" || req.body?.async === true;
    if (asyncMode) {
      const job = await enqueueCampaignDispatch({ company_id, campaignId: id, user_id: req.user.id });
      return res.status(202).json({ queued: true, job });
    }

    const result = await dispatchCampaign({ req, company_id, campaignId: id, user_id: req.user.id });
    return res.json(result);
  } catch (err) {
    console.error("dispatchCampaign error:", err);
    return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
  }
};

exports.getCampaignStatus = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const { id } = req.params;

    const campaign = await prisma.messageCampaign.findFirst({
      where: { id, company_id }
    });
    if (!campaign) return res.status(404).json({ message: "Campaign not found" });

    const [counts, latestJob] = await Promise.all([
      prisma.messageLog.groupBy({
        by: ["status"],
        where: { company_id, messageCampaignId: id },
        _count: { status: true }
      }),
      prisma.messageDispatchJob.findFirst({
        where: { company_id, campaign_id: id },
        orderBy: { created_at: "desc" }
      })
    ]);

    return res.json({ campaign, counts, latest_job: latestJob });
  } catch (err) {
    console.error("getCampaignStatus error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getOutbox = async (req, res) => {
  try {
    const company_id = req.user.company_id;

    const channel = (req.query.channel || "").toString().trim();
    const status = (req.query.status || "").toString().trim();
    const campaignId = (req.query.campaign_id || "").toString().trim();

    const where = { company_id };
    if (channel) where.channel = channel;
    if (status) where.status = status;
    if (campaignId) where.messageCampaignId = campaignId;

    const pagination = getPagination(req, { defaultPageSize: 50, maxPageSize: 200 });
    const query = {
      where,
      orderBy: [{ created_at: "desc" }, { id: "desc" }]
    };
    if (pagination.enabled) {
      query.skip = pagination.skip;
      query.take = pagination.take;
    } else {
      query.take = 200;
    }

    const [logs, total] = await Promise.all([
      prisma.messageLog.findMany(query),
      pagination.enabled && pagination.include_total ? prisma.messageLog.count({ where }) : Promise.resolve(null)
    ]);

    if (!pagination.enabled) return res.json(logs);

    return res.json({
      items: logs,
      pagination: buildPaginationMeta({ page: pagination.page, page_size: pagination.page_size, total: total ?? logs.length })
    });
  } catch (err) {
    console.error("getOutbox error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// POST /messages/campaigns/from-filter
// Creates a campaign and auto-populates recipients based on common business filters.
// Example: remind all clients with PARTIALLY_PAID invoices.
exports.createCampaignFromFilter = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const { name, channel, template_id, purpose, factory_id, filter } = req.body || {};

    if (!name) return res.status(400).json({ message: "name is required" });
    if (!channel || !["EMAIL", "WHATSAPP"].includes(channel)) {
      return res.status(400).json({ message: "channel must be EMAIL or WHATSAPP" });
    }

    const f = filter || {};
    const invoice_statuses = Array.isArray(f.invoice_statuses) ? f.invoice_statuses : [];
    const order_statuses = Array.isArray(f.order_statuses) ? f.order_statuses : [];
    const inactive_days = Number(f.inactive_days || 0);

    // Find target client IDs
    const clientIds = new Set();

    if (invoice_statuses.length) {
      const rows = await prisma.invoice.findMany({
        where: {
          company_id,
          ...(factory_id ? invoiceVisibilityWhere({ factory_id }) : {}),
          is_active: true,
          status: { in: invoice_statuses }
        },
        select: { client_id: true }
      });
      rows.forEach(r => r.client_id && clientIds.add(r.client_id));
    }

    if (order_statuses.length) {
      const rows = await prisma.order.findMany({
        where: {
          company_id,
          ...(factory_id ? orderVisibilityWhere({ factory_id }) : {}),
          is_active: true,
          status: { in: order_statuses }
        },
        select: { client_id: true }
      });
      rows.forEach(r => r.client_id && clientIds.add(r.client_id));
    }

    if (inactive_days > 0) {
      const cutoff = new Date(Date.now() - inactive_days * 24 * 3600 * 1000);
      const clients = await prisma.client.findMany({
        where: { company_id, is_active: true },
        select: { id: true }
      });
      const lastOrders = await prisma.order.groupBy({
        by: ["client_id"],
        where: { company_id, is_active: true, ...(factory_id ? orderVisibilityWhere({ factory_id }) : {}) },
        _max: { order_date: true }
      });
      const lastOrderMap = new Map(lastOrders.map((row) => [row.client_id, row._max.order_date]));
      for (const c of clients) {
        const lastDate = lastOrderMap.get(c.id);
        if (!lastDate || new Date(lastDate) < cutoff) clientIds.add(c.id);
      }
    }

    if (clientIds.size === 0) {
      return res.status(400).json({ message: "No recipients match the provided filter" });
    }

    const campaign = await prisma.messageCampaign.create({
      data: {
        company_id,
        name,
        channel,
        template_id: template_id || null,
        purpose: purpose || null,
        factory_id: factory_id || null,
        created_by: req.user.id
      }
    });

    // Resolve recipients via first active contact (preferred) or client email/phone
    const clients = await prisma.client.findMany({
      where: { company_id, id: { in: Array.from(clientIds) }, is_active: true },
      include: { contacts: { where: { is_active: true }, orderBy: { created_at: "asc" } } }
    });

    const recipients = [];
    for (const c of clients) {
      const email = c.contacts?.find(x => x.email)?.email || c.email || null;
      const phone = c.contacts?.find(x => x.phone)?.phone || null;
      recipients.push({
        company_id,
        campaign_id: campaign.id,
        client_id: c.id,
        contact_id: c.contacts?.[0]?.id || null,
        to_email: email,
        to_phone: phone,
        payload: { client_name: c.company_name }
      });
    }

    await prisma.messageRecipient.createMany({ data: recipients });

    return res.status(201).json({ campaign, recipients_count: recipients.length });
  } catch (err) {
    console.error("createCampaignFromFilter error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// POST /messages/campaigns/promotional
// Sends promotional messages to either ALL clients or a selected list.
// Example use-case: new product launch / festive offers.
// Body:
// {
//   name, channel: 'EMAIL'|'WHATSAPP',
//   subject?, body?, template_id?, purpose?,
//   selection: { all?: true, client_ids?: [] }
// }
exports.createPromotionalCampaign = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const {
      name,
      channel,
      template_id,
      purpose,
      subject,
      body,
      selection
    } = req.body || {};

    if (!name) return res.status(400).json({ message: "name is required" });
    if (!channel || !["EMAIL", "WHATSAPP"].includes(channel)) {
      return res.status(400).json({ message: "channel must be EMAIL or WHATSAPP" });
    }

    const sel = selection || {};
    const client_ids = Array.isArray(sel.client_ids) ? sel.client_ids.filter(Boolean) : [];
    const sendAll = !!sel.all;

    if (!sendAll && client_ids.length === 0) {
      return res.status(400).json({ message: "selection must specify all=true or a non-empty client_ids array" });
    }

    // For quick promotional emails, allow passing subject/body directly.
    // If not provided, caller can pass template_id (pre-created in DB).
    let templateId = template_id || null;
    if (!templateId) {
      if (channel === "EMAIL") {
        if (!subject) return res.status(400).json({ message: "subject is required for EMAIL when template_id is not provided" });
        if (!body) return res.status(400).json({ message: "body is required for EMAIL when template_id is not provided" });
      }

      const tpl = await prisma.messageTemplate.create({
        data: {
          company_id,
          name: `promo-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          channel,
          subject: channel === "EMAIL" ? String(subject) : null,
          body: String(body || ""),
          is_active: true,
          created_by: req.user.id
        }
      });
      templateId = tpl.id;
    }

    // Resolve clients
    const clients = await prisma.client.findMany({
      where: {
        company_id,
        is_active: true,
        ...(sendAll ? {} : { id: { in: client_ids } })
      },
      include: {
        contacts: { where: { is_active: true }, orderBy: { created_at: "asc" } }
      }
    });

    if (!clients.length) {
      return res.status(400).json({ message: "No clients found for the selected criteria" });
    }

    const campaign = await prisma.messageCampaign.create({
      data: {
        company_id,
        name,
        channel,
        template_id: templateId,
        purpose: purpose || "PROMOTIONAL",
        factory_id: null,
        created_by: req.user.id
      }
    });

    const recipients = [];
    for (const c of clients) {
      const email = c.contacts?.find(x => x.email)?.email || c.email || null;
      const phone = c.contacts?.find(x => x.phone)?.phone || null;
      recipients.push({
        company_id,
        campaign_id: campaign.id,
        client_id: c.id,
        contact_id: c.contacts?.[0]?.id || null,
        to_email: email,
        to_phone: phone,
        payload: { client_name: c.company_name }
      });
    }

    await prisma.messageRecipient.createMany({ data: recipients });

    return res.status(201).json({ campaign, recipients_count: recipients.length });
  } catch (err) {
    console.error("createPromotionalCampaign error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};
