// S3-backed attachment storage, in two halves that share one bucket:
//
//   assets/<name>            durable, named, reused. Upload a pricing sheet
//                            once and every future send references it by name,
//                            so the bytes never travel through a tool call and
//                            size stops mattering. Updating the file updates
//                            every send that follows.
//
//   pending/<schedule>/<n>   ephemeral, one prefix per scheduled send. Bytes
//                            resolved at schedule time wait here until the
//                            worker fires, because EventBridge Scheduler caps
//                            its payload at 256 KB — far too small for a
//                            document. The worker deletes the prefix after
//                            delivering; a lifecycle rule sweeps whatever a
//                            cancelled or failed schedule leaves behind.
//
// Inert when ASSETS_BUCKET is unset, which is the case for a local stdio
// install — assets then report as unavailable rather than failing obscurely.
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";

const BUCKET = process.env.ASSETS_BUCKET || "";
const client = BUCKET ? new S3Client({}) : null;

export const storageOn = () => Boolean(BUCKET);
export const bucketName = () => BUCKET;

// Asset names become S3 keys and appear in tool arguments, so keep them to an
// obvious slug rather than trusting arbitrary input into a key path.
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
export function assertAssetName(name) {
  if (!NAME_RE.test(String(name || "")) || String(name).includes("..")) {
    throw new Error(`invalid asset name "${name}" — use letters, digits, dot, dash or underscore (max 64).`);
  }
  return name;
}

const assetKey = (name) => `assets/${assertAssetName(name)}`;
export const pendingPrefix = (scheduleId) => `pending/${scheduleId}/`;

const bodyToBuffer = async (body) => Buffer.from(await body.transformToByteArray());

function requireBucket() {
  if (!client) {
    throw new Error(
      "Asset storage is not configured on this server (no ASSETS_BUCKET). Named assets are available on the remote deployment."
    );
  }
}

// ---- named assets ----

export async function putAsset(name, { content, filename, contentType }) {
  requireBucket();
  await client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: assetKey(name),
      Body: content,
      ContentType: contentType || "application/octet-stream",
      // The filename recipients see is a property of the asset, not the slug.
      Metadata: { filename: filename || name },
    })
  );
  return { name, bytes: content.length, filename: filename || name };
}

export async function getAsset(name) {
  requireBucket();
  let out;
  try {
    out = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: assetKey(name) }));
  } catch (e) {
    if (e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404) {
      const known = await listAssets().catch(() => []);
      throw new Error(
        `no asset named "${name}"` + (known.length ? ` — available: ${known.map((a) => a.name).join(", ")}` : " (none uploaded yet)")
      );
    }
    throw e;
  }
  return {
    filename: out.Metadata?.filename || name,
    contentType: out.ContentType,
    content: await bodyToBuffer(out.Body),
  };
}

export async function listAssets() {
  requireBucket();
  const out = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: "assets/" }));
  const rows = [];
  for (const o of out.Contents || []) {
    const name = o.Key.slice("assets/".length);
    if (!name) continue;
    let filename = name;
    let contentType;
    try {
      const head = await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: o.Key }));
      filename = head.Metadata?.filename || name;
      contentType = head.ContentType;
    } catch {
      /* listing should survive a race with a delete */
    }
    rows.push({ name, filename, contentType, bytes: o.Size, updated: o.LastModified });
  }
  return rows;
}

export async function deleteAsset(name) {
  requireBucket();
  await client.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: [{ Key: assetKey(name) }] } }));
}

// ---- per-schedule spool ----

// Park resolved attachments for a scheduled send; returns the keys to carry in
// the (size-capped) schedule payload instead of the bytes themselves.
export async function spoolPending(scheduleId, attachments) {
  requireBucket();
  const prefix = pendingPrefix(scheduleId);
  const keys = [];
  for (const [i, a] of attachments.entries()) {
    const Key = `${prefix}${i}`;
    await client.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key,
        Body: a.content,
        ContentType: a.contentType || "application/octet-stream",
        Metadata: { filename: a.filename },
      })
    );
    keys.push({ key: Key, filename: a.filename, content_type: a.contentType });
  }
  return keys;
}

export async function fetchKey(key) {
  requireBucket();
  const out = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return {
    filename: out.Metadata?.filename,
    contentType: out.ContentType,
    content: await bodyToBuffer(out.Body),
  };
}

// Best-effort cleanup once a scheduled send has gone out. The lifecycle rule on
// pending/ is the backstop for cancelled schedules and failed deliveries.
export async function dropPending(scheduleId) {
  requireBucket();
  const prefix = pendingPrefix(scheduleId);
  const out = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));
  const Objects = (out.Contents || []).map((o) => ({ Key: o.Key }));
  if (Objects.length) await client.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects } }));
  return Objects.length;
}
