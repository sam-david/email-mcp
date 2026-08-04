// Send-worker Lambda. EventBridge Scheduler invokes this at the scheduled time
// with the event { profile, to, subject, body, cc?, bcc?, html?, attachments? }.
// It fetches the profile's creds from Secrets Manager and delivers via SMTP.
//
// Attachments arrive as [{ filename, content_base64, content_type? }] — already
// resolved to bytes when the send was scheduled, since a local file path means
// nothing here and the mailbox may have changed by fire time.
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import nodemailer from "nodemailer";

const PREFIX = process.env.SECRETS_PREFIX || "email-mcp/";
const sm = new SecretsManagerClient({});

export async function handler(event) {
  const { profile, to, subject, body, cc, bcc, html, attachments } = event || {};
  if (!profile || !to) throw new Error("scheduled send event missing profile/to");

  const res = await sm.send(new GetSecretValueCommand({ SecretId: `${PREFIX}${profile}` }));
  const j = JSON.parse(res.SecretString || "{}");
  const port = Number(j.smtpPort || 465);
  const from = j.fromName ? `"${j.fromName}" <${j.fromAddress || j.email}>` : j.fromAddress || j.email;

  const transport = nodemailer.createTransport({
    host: j.smtpHost || "smtp.zoho.com",
    port,
    secure: port === 465,
    auth: { user: j.email, pass: j.password },
  });

  const files = (attachments || []).map((a) => ({
    filename: a.filename,
    content: Buffer.from(a.content_base64, "base64"),
    contentType: a.content_type || undefined,
  }));

  const info = await transport.sendMail({
    from,
    to,
    cc,
    bcc,
    subject,
    text: body,
    html,
    ...(files.length ? { attachments: files } : {}),
  });
  console.log(
    "scheduled send delivered:",
    JSON.stringify({ profile, to, subject, attachments: files.length, messageId: info.messageId })
  );
  return { ok: true, messageId: info.messageId };
}
