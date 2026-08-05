// Send-worker Lambda. EventBridge Scheduler invokes this at the scheduled time
// with { profile, to, subject, body, cc?, bcc?, html?, attachment_keys?,
// attachments? }. It fetches the profile's creds from Secrets Manager and
// delivers via SMTP.
//
// Attachments arrive one of two ways, both resolved to bytes when the send was
// scheduled (a local path means nothing here, and a source message may be gone
// by fire time):
//
//   attachment_keys  S3 keys under pending/<schedule>/ or assets/. The normal
//                    path — Scheduler caps its payload at 256 KB, so anything
//                    document-sized has to wait in S3 rather than in the event.
//   attachments      inline base64. Fallback for deployments without a bucket.
//
// After a successful send the pending/ prefix is deleted; the bucket lifecycle
// rule is only a backstop for schedules that were cancelled or never fired.
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { S3Client, GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import nodemailer from "nodemailer";

const PREFIX = process.env.SECRETS_PREFIX || "email-mcp/";
const BUCKET = process.env.ASSETS_BUCKET || "";
const sm = new SecretsManagerClient({});
const s3 = BUCKET ? new S3Client({}) : null;

async function fetchAttachments(keys) {
  if (!keys?.length) return [];
  if (!s3) throw new Error("scheduled send references S3 keys but ASSETS_BUCKET is not set");
  return Promise.all(
    keys.map(async (k) => {
      const out = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: k.key }));
      return {
        filename: k.filename || out.Metadata?.filename || "attachment",
        content: Buffer.from(await out.Body.transformToByteArray()),
        contentType: k.content_type || out.ContentType || undefined,
      };
    })
  );
}

// Remove the spool prefix for this schedule. Best effort: a delivered email
// must not be reported as failed just because cleanup did not complete.
async function dropPending(keys) {
  if (!s3 || !keys?.length) return 0;
  const prefixes = [...new Set(keys.map((k) => k.key).filter((k) => k.startsWith("pending/")).map((k) => k.split("/").slice(0, 2).join("/") + "/"))];
  let removed = 0;
  for (const Prefix of prefixes) {
    const out = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix }));
    const Objects = (out.Contents || []).map((o) => ({ Key: o.Key }));
    if (Objects.length) {
      await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects } }));
      removed += Objects.length;
    }
  }
  return removed;
}

export async function handler(event) {
  const { profile, to, subject, body, cc, bcc, html, attachments, attachment_keys } = event || {};
  if (!profile || !to) throw new Error("scheduled send event missing profile/to");

  const res = await sm.send(new GetSecretValueCommand({ SecretId: `${PREFIX}${profile}` }));
  const j = JSON.parse(res.SecretString || "{}");
  const port = Number(j.smtpPort || 465);
  const from = j.fromName ? `"${j.fromName}" <${j.fromAddress || j.email}>` : j.fromAddress || j.email;

  const files = [
    ...(await fetchAttachments(attachment_keys)),
    ...(attachments || []).map((a) => ({
      filename: a.filename,
      content: Buffer.from(a.content_base64, "base64"),
      contentType: a.content_type || undefined,
    })),
  ];

  const transport = nodemailer.createTransport({
    host: j.smtpHost || "smtp.zoho.com",
    port,
    secure: port === 465,
    auth: { user: j.email, pass: j.password },
  });

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

  // Only after delivery — a failed send is retried, and needs its bytes intact.
  let cleaned = 0;
  try {
    cleaned = await dropPending(attachment_keys);
  } catch (e) {
    console.log("spool cleanup failed (lifecycle rule will sweep):", String(e?.message || e));
  }

  console.log(
    "scheduled send delivered:",
    JSON.stringify({ profile, to, subject, attachments: files.length, cleaned, messageId: info.messageId })
  );
  return { ok: true, messageId: info.messageId };
}
