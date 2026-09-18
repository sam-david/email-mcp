// Shared SMTP send, used by both the MCP server (send_email) and the scheduled
// send-worker Lambda, so immediate and scheduled sends behave identically.
import nodemailer from "nodemailer";

// Compose the exact MIME message we would put on the wire, without sending it.
// Used by save_draft so a draft is byte-for-byte what a send would produce --
// same From, same alias handling, same attachment encoding.
export async function buildMime(cfg, { to, subject, body, cc, bcc, html, attachments, inReplyTo, references }) {
  const composer = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const info = await composer.sendMail({
    from: buildFrom(cfg),
    to,
    cc,
    bcc,
    subject,
    text: body,
    html,
    ...(attachments?.length ? { attachments } : {}),
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(references?.length ? { references } : {}),
    date: new Date(),
  });
  return info.message;
}

export function buildFrom(cfg) {
  return cfg.fromName ? `"${cfg.fromName}" <${cfg.fromAddress}>` : cfg.fromAddress;
}

// `attachments` is already in nodemailer form ({ filename, content, contentType })
// — see attachments.mjs, which resolves the various byte sources into it.
// inReplyTo / references carry RFC 5322 threading. Without them a reply lands
// as a detached new message in the recipient's client instead of in the
// conversation it answers.
export async function sendMail(cfg, { to, subject, body, cc, bcc, html, attachments, inReplyTo, references }) {
  const transport = nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: cfg.smtpPort === 465,
    auth: { user: cfg.email, pass: cfg.pass },
  });
  return transport.sendMail({
    from: buildFrom(cfg),
    to,
    cc,
    bcc,
    subject,
    text: body,
    html,
    ...(attachments?.length ? { attachments } : {}),
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(references?.length ? { references } : {}),
  });
}
