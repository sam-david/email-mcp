// Shared SMTP send, used by both the MCP server (send_email) and the scheduled
// send-worker Lambda, so immediate and scheduled sends behave identically.
import nodemailer from "nodemailer";

export function buildFrom(cfg) {
  return cfg.fromName ? `"${cfg.fromName}" <${cfg.fromAddress}>` : cfg.fromAddress;
}

export async function sendMail(cfg, { to, subject, body, cc, bcc, html }) {
  const transport = nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: cfg.smtpPort === 465,
    auth: { user: cfg.email, pass: cfg.pass },
  });
  return transport.sendMail({ from: buildFrom(cfg), to, cc, bcc, subject, text: body, html });
}
