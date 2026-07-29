// Send-worker Lambda. EventBridge Scheduler invokes this at the scheduled time
// with the event { profile, to, subject, body, cc?, bcc?, html? }. It fetches
// the profile's creds from Secrets Manager and delivers via SMTP.
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import nodemailer from "nodemailer";

const PREFIX = process.env.SECRETS_PREFIX || "email-mcp/";
const sm = new SecretsManagerClient({});

export async function handler(event) {
  const { profile, to, subject, body, cc, bcc, html } = event || {};
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

  const info = await transport.sendMail({ from, to, cc, bcc, subject, text: body, html });
  console.log("scheduled send delivered:", JSON.stringify({ profile, to, subject, messageId: info.messageId }));
  return { ok: true, messageId: info.messageId };
}
