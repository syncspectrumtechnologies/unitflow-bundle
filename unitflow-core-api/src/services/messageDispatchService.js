const fs = require("fs");
const prisma = require("../config/db");
const { sendEmailWithAttachment } = require("./smtpService");
const { sendWhatsAppDocumentBuffer, sendWhatsAppText } = require("./metaWhatsAppService");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ratePerSecond() {
  const v = Number(process.env.MESSAGE_SEND_RATE_PER_SEC || 2);
  return Number.isFinite(v) && v > 0 ? v : 2;
}

function maxPerRun() {
  const v = Number(process.env.MESSAGE_MAX_PER_CAMPAIGN_RUN || 500);
  return Number.isFinite(v) && v > 0 ? v : 500;
}

async function updateJob(jobId, data) {
  if (!jobId) return null;
  return prisma.messageDispatchJob.update({ where: { id: jobId }, data });
}

async function logQueued({ company_id, channel, to, created_by, factory_id, client_id, order_id, invoice_id, payload, campaignId }) {
  return prisma.messageLog.create({
    data: {
      company_id,
      channel,
      to,
      status: "QUEUED",
      payload: payload || {},
      created_by: created_by || null,
      factory_id: factory_id || null,
      client_id: client_id || null,
      order_id: order_id || null,
      invoice_id: invoice_id || null,
      provider: null,
      provider_id: null,
      error: null,
      campaign_id: campaignId || null,
      messageCampaignId: campaignId || null
    }
  });
}

async function markLog({ id, status, provider, provider_id, error }) {
  return prisma.messageLog.update({
    where: { id },
    data: {
      status,
      provider: provider || undefined,
      provider_id: provider_id || undefined,
      error: error || null
    }
  });
}

async function sendTransactionalEmailPdf({ toEmail, toName, subject, html, pdfPath, logId }) {
  const buf = fs.readFileSync(pdfPath);
  const resp = await sendEmailWithAttachment({
    toEmail,
    toName,
    subject,
    html,
    attachmentName: subject?.includes("Invoice") ? "invoice.pdf" : "label.pdf",
    attachmentBuffer: buf
  });

  await markLog({ id: logId, status: "SENT", provider: "smtp", provider_id: null, error: null });
  return resp;
}

async function sendTransactionalEmail({ toEmail, toName, subject, html, logId }) {
  const resp = await sendEmailWithAttachment({
    toEmail,
    toName,
    subject,
    html,
    attachmentBuffer: null
  });

  if (logId) {
    await markLog({ id: logId, status: "SENT", provider: "smtp", provider_id: null, error: null });
  }
  return resp;
}

async function sendTransactionalWhatsAppPdf({ toPhone, caption, pdfPath, logId }) {
  const buf = fs.readFileSync(pdfPath);
  const resp = await sendWhatsAppDocumentBuffer({
    toPhone,
    buffer: buf,
    filename: "document.pdf",
    caption
  });

  const providerId = resp?.messages?.[0]?.id || null;
  await markLog({ id: logId, status: "SENT", provider: "meta", provider_id: providerId, error: null });
  return resp;
}

async function dispatchCampaignCore({ company_id, campaignId, user_id, jobId = null }) {
  const campaign = await prisma.messageCampaign.findFirst({
    where: { id: campaignId, company_id },
    include: { template: true }
  });
  if (!campaign) {
    const err = new Error("Campaign not found");
    err.statusCode = 404;
    throw err;
  }

  const recipients = await prisma.messageRecipient.findMany({
    where: { company_id, campaign_id: campaignId },
    orderBy: { created_at: "asc" },
    take: maxPerRun()
  });

  const rps = ratePerSecond();
  const delayMs = Math.ceil(1000 / rps);

  await updateJob(jobId, { total_recipients: recipients.length, processed_count: 0, sent_count: 0, failed_count: 0 });

  const results = [];
  let sent_count = 0;
  let failed_count = 0;

  for (let index = 0; index < recipients.length; index += 1) {
    const r = recipients[index];
    const to = campaign.channel === "EMAIL" ? (r.to_email || "") : (r.to_phone || "");
    if (!to) continue;

    const log = await logQueued({
      company_id,
      channel: campaign.channel,
      to,
      created_by: user_id,
      factory_id: campaign.factory_id || null,
      client_id: r.client_id || null,
      payload: r.payload || {},
      campaignId
    });

    try {
      if (campaign.channel === "EMAIL") {
        const subject = campaign.template?.subject || campaign.name;
        const html = campaign.template?.body || "<p>Hello</p>";
        await sendEmailWithAttachment({
          toEmail: r.to_email,
          toName: null,
          subject,
          html,
          attachmentBuffer: null
        });
        await markLog({ id: log.id, status: "SENT", provider: "smtp", provider_id: null, error: null });
      } else {
        const text = campaign.template?.body || "Hello";
        const resp = await sendWhatsAppText({ toPhone: r.to_phone, text });
        await markLog({
          id: log.id,
          status: "SENT",
          provider: "meta",
          provider_id: resp?.messages?.[0]?.id || null,
          error: null
        });
      }
      sent_count += 1;
      results.push({ id: log.id, status: "SENT" });
    } catch (e) {
      failed_count += 1;
      await markLog({
        id: log.id,
        status: "FAILED",
        provider: campaign.channel === "EMAIL" ? "smtp" : "meta",
        provider_id: null,
        error: e?.message || "Send failed"
      });
      results.push({ id: log.id, status: "FAILED", error: e?.message });
    }

    await updateJob(jobId, {
      processed_count: index + 1,
      sent_count,
      failed_count
    });

    await sleep(delayMs);
  }

  return { campaignId, count: results.length, sent_count, failed_count, results };
}

async function dispatchCampaign({ company_id, campaignId, user_id }) {
  return dispatchCampaignCore({ company_id, campaignId, user_id, jobId: null });
}

async function enqueueCampaignDispatch({ company_id, campaignId, user_id }) {
  const total_recipients = await prisma.messageRecipient.count({
    where: { company_id, campaign_id: campaignId }
  });

  return prisma.messageDispatchJob.create({
    data: {
      company_id,
      campaign_id: campaignId,
      status: "QUEUED",
      created_by: user_id || null,
      total_recipients
    }
  });
}

module.exports = {
  logQueued,
  dispatchCampaign,
  dispatchCampaignCore,
  enqueueCampaignDispatch,
  sendTransactionalEmail,
  sendTransactionalEmailPdf,
  sendTransactionalWhatsAppPdf
};
