const net = require("net");
const tls = require("tls");

function requireEnv(key) {
  const v = process.env[key];
  if (!v) {
    const err = new Error(`${key} is not set`);
    err.statusCode = 501;
    throw err;
  }
  return v;
}

function b64(v) {
  return Buffer.from(String(v), "utf8").toString("base64");
}

function chunkBase64(buf) {
  const b = Buffer.isBuffer(buf) ? buf.toString("base64") : "";
  // 76 chars per line per RFC
  return b.replace(/(.{1,76})/g, "$1\r\n").trimEnd();
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildMime({ fromEmail, fromName, toEmail, subject, html, attachmentName, attachmentBuffer }) {
  const mix = `mix_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const alt = `alt_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  const safeSubject = String(subject || "Document").replace(/[\r\n]/g, " ");
  const fromLine = fromName ? `"${String(fromName).replace(/"/g, "'")}" <${fromEmail}>` : `<${fromEmail}>`;

  const text = stripHtml(html);

  const headers = [
    `From: ${fromLine}`,
    `To: <${toEmail}>`,
    `Subject: ${safeSubject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${mix}"`
  ].join("\r\n");

  const altPart = [
    `--${mix}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    "",
    `--${alt}`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: 7bit`,
    "",
    text || " ",
    "",
    `--${alt}`,
    `Content-Type: text/html; charset=utf-8`,
    `Content-Transfer-Encoding: 7bit`,
    "",
    String(html || "<p></p>"),
    "",
    `--${alt}--`,
    ""
  ].join("\r\n");

  let attachPart = "";
  if (attachmentBuffer && Buffer.isBuffer(attachmentBuffer)) {
    const name = attachmentName || "document.pdf";
    attachPart = [
      `--${mix}`,
      `Content-Type: application/pdf; name="${name}"`,
      `Content-Disposition: attachment; filename="${name}"`,
      `Content-Transfer-Encoding: base64`,
      "",
      chunkBase64(attachmentBuffer),
      ""
    ].join("\r\n");
  }

  const end = `--${mix}--`;

  // Dot-stuffing in DATA happens later.
  return `${headers}\r\n\r\n${altPart}${attachPart}${end}\r\n`;
}

function dotStuff(data) {
  // In SMTP DATA, any line starting with '.' must be prefixed with another '.'
  return data.replace(/\r\n\./g, "\r\n..");
}

async function smtpSend({
  host,
  port,
  secure,
  username,
  password,
  fromEmail,
  fromName,
  toEmail,
  subject,
  html,
  attachmentName,
  attachmentBuffer
}) {
  const p = Number(port);
  const useSecure = !!secure;

  const connect = () =>
    new Promise((resolve, reject) => {
      const socket = useSecure
        ? tls.connect(p, host, { servername: host }, () => resolve(socket))
        : net.connect(p, host, () => resolve(socket));

      socket.setTimeout(30_000);
      socket.on("error", reject);
      socket.on("timeout", () => reject(new Error("SMTP connection timeout")));
    });

  const socket = await connect();
  socket.setEncoding("utf8");

  const readResponse = () =>
    new Promise((resolve, reject) => {
      let data = "";
      const onData = (chunk) => {
        data += chunk;
        // response ends when we have a line with code + space
        const lines = data.split(/\r\n/).filter(Boolean);
        if (!lines.length) return;
        const last = lines[lines.length - 1];
        if (/^\d{3}\s/.test(last)) {
          socket.off("data", onData);
          resolve(data);
        }
      };
      socket.on("data", onData);
      socket.on("error", (e) => {
        socket.off("data", onData);
        reject(e);
      });
    });

  const sendCmd = async (cmd, expectCode) => {
    socket.write(cmd + "\r\n");
    const resp = await readResponse();
    if (expectCode && !resp.startsWith(String(expectCode))) {
      const err = new Error(`SMTP error for ${cmd}: ${resp.trim()}`);
      err.smtp = resp;
      throw err;
    }
    return resp;
  };

  // greeting
  await readResponse();

  const ehloResp = await sendCmd(`EHLO ${host}`, 250);

  const supportsStartTls = /\bSTARTTLS\b/i.test(ehloResp);
  const wantStartTls = !useSecure && supportsStartTls && String(process.env.SMTP_STARTTLS || "1") !== "0";

  let activeSocket = socket;
  if (wantStartTls) {
    await sendCmd("STARTTLS", 220);
    // Upgrade to TLS
    activeSocket = tls.connect({ socket, servername: host });
    activeSocket.setEncoding("utf8");
    // Rebind helpers to the new socket
    // (Simpler approach: re-run handshake with small wrappers)
    const newSocket = activeSocket;
    const readRespTLS = () =>
      new Promise((resolve, reject) => {
        let data = "";
        const onData = (chunk) => {
          data += chunk;
          const lines = data.split(/\r\n/).filter(Boolean);
          if (!lines.length) return;
          const last = lines[lines.length - 1];
          if (/^\d{3}\s/.test(last)) {
            newSocket.off("data", onData);
            resolve(data);
          }
        };
        newSocket.on("data", onData);
        newSocket.on("error", (e) => {
          newSocket.off("data", onData);
          reject(e);
        });
      });

    const sendCmdTLS = async (cmd, expectCode) => {
      newSocket.write(cmd + "\r\n");
      const resp = await readRespTLS();
      if (expectCode && !resp.startsWith(String(expectCode))) {
        const err = new Error(`SMTP error for ${cmd}: ${resp.trim()}`);
        err.smtp = resp;
        throw err;
      }
      return resp;
    };

    await sendCmdTLS(`EHLO ${host}`, 250);

    // AUTH (PLAIN preferred)
    if (username && password) {
      const authPlain = `\u0000${username}\u0000${password}`;
      await sendCmdTLS(`AUTH PLAIN ${b64(authPlain)}`, 235);
    }

    await sendCmdTLS(`MAIL FROM:<${fromEmail}>`, 250);
    await sendCmdTLS(`RCPT TO:<${toEmail}>`, 250);
    await sendCmdTLS("DATA", 354);

    const mime = dotStuff(
      buildMime({ fromEmail, fromName, toEmail, subject, html, attachmentName, attachmentBuffer })
    );
    newSocket.write(mime + "\r\n.\r\n");
    const dataResp = await readRespTLS();
    if (!dataResp.startsWith("250")) {
      const err = new Error(`SMTP DATA rejected: ${dataResp.trim()}`);
      err.smtp = dataResp;
      throw err;
    }

    await sendCmdTLS("QUIT", 221);
    newSocket.end();
    return { ok: true };
  }

  // AUTH (no STARTTLS path)
  if (username && password) {
    const authPlain = `\u0000${username}\u0000${password}`;
    await sendCmd(`AUTH PLAIN ${b64(authPlain)}`, 235);
  }

  await sendCmd(`MAIL FROM:<${fromEmail}>`, 250);
  await sendCmd(`RCPT TO:<${toEmail}>`, 250);
  await sendCmd("DATA", 354);

  const mime = dotStuff(buildMime({ fromEmail, fromName, toEmail, subject, html, attachmentName, attachmentBuffer }));
  socket.write(mime + "\r\n.\r\n");
  const dataResp = await readResponse();
  if (!dataResp.startsWith("250")) {
    const err = new Error(`SMTP DATA rejected: ${dataResp.trim()}`);
    err.smtp = dataResp;
    throw err;
  }

  await sendCmd("QUIT", 221);
  socket.end();
  return { ok: true };
}

async function sendEmailWithAttachment({ toEmail, toName, subject, html, attachmentName, attachmentBuffer }) {
  const host = requireEnv("SMTP_HOST");
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || "0") === "1";
  const username = process.env.SMTP_USER || null;
  const password = process.env.SMTP_PASS || null;
  const fromEmail = process.env.SMTP_FROM_EMAIL || requireEnv("SMTP_FROM");
  const fromName = process.env.SMTP_FROM_NAME || "UnitFlow";

  // toName is unused in SMTP envelope; it can be embedded in headers later if needed.
  return smtpSend({
    host,
    port,
    secure,
    username,
    password,
    fromEmail,
    fromName,
    toEmail,
    subject,
    html,
    attachmentName,
    attachmentBuffer
  });
}

module.exports = { sendEmailWithAttachment };
