// Attachment handling for send_email / schedule_send.
//
// The awkward part of attachments over MCP is *where the bytes come from*, and
// that differs by transport, so each entry names exactly one source:
//
//   path            a file on the machine running the server. Only honoured
//                   over stdio, where the server is a local subprocess and the
//                   filesystem is the user's own. Refused over HTTP, where it
//                   would read the *server's* disk on behalf of a remote
//                   caller — useless at best, an exfiltration primitive at worst.
//   content_base64  inline bytes. Works on every transport; the only option a
//                   claude.ai connector has, and the right one for content the
//                   model generated itself (a CSV, a report).
//   from_uid        re-attach a file already sitting on a message in the
//                   mailbox — forwarding. Needs no I/O beyond the IMAP
//                   connection we already hold.
//
// Deliberately absent: fetching a URL. This server's security claim is that it
// talks only to the configured mail hosts, and a URL fetcher would hand any
// caller a general-purpose outbound request.
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { simpleParser } from "mailparser";
// The same table nodemailer uses when it fills in a missing contentType, so a
// send preview names the exact type that will go out on the wire.
import mimeTypes from "nodemailer/lib/mime-funcs/mime-types.js";

// Most providers reject well before this (Zoho ~20 MB, Gmail 25 MB); fail here
// with something readable rather than after a long upload.
export const MAX_ONE = 20 * 1024 * 1024;
export const MAX_TOTAL = 25 * 1024 * 1024;

// EventBridge Scheduler caps Target.Input at 256 KB and the payload is
// JSON-with-base64, so scheduled sends get a much smaller budget than immediate
// ones. Leave headroom for the body and envelope.
export const MAX_SCHEDULED_TOTAL = 150 * 1024;

const human = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

const typeOf = (a) => a.contentType || mimeTypes.detectMimeType(a.filename || "") || "application/octet-stream";

// Pull the attachments off a message, optionally just the one named.
async function fromMessage(withImap, { uid, mailbox = "INBOX", filename }) {
  if (!withImap) throw new Error("from_uid is not available here.");
  const parsed = await withImap(async (c) => {
    await c.mailboxOpen(mailbox, { readOnly: true });
    const msg = await c.fetchOne(uid, { source: true }, { uid: true });
    if (!msg || !msg.source) throw new Error(`no message with uid ${uid} in ${mailbox}`);
    return simpleParser(msg.source);
  });
  const all = parsed.attachments || [];
  if (!all.length) throw new Error(`message uid ${uid} has no attachments`);
  const picked = filename ? all.filter((a) => a.filename === filename) : all;
  if (!picked.length) {
    throw new Error(`message uid ${uid} has no attachment named "${filename}" (has: ${all.map((a) => a.filename || "(unnamed)").join(", ")})`);
  }
  return picked.map((a) => ({
    filename: a.filename || `attachment-${uid}`,
    content: a.content,
    contentType: a.contentType,
  }));
}

// Turn the tool's attachment specs into nodemailer attachment objects.
// `withImap` is the server's IMAP helper; `allowLocalFiles` gates `path`.
export async function resolveAttachments(specs, { allowLocalFiles = false, withImap = null, maxTotal = MAX_TOTAL } = {}) {
  if (!specs || !specs.length) return [];
  const out = [];

  for (const [i, a] of specs.entries()) {
    const label = `attachment ${i + 1}`;
    const given = ["path", "content_base64", "from_uid"].filter((k) => a[k] !== undefined && a[k] !== null && a[k] !== "");
    if (given.length !== 1) {
      throw new Error(
        `${label}: give exactly one of path, content_base64 or from_uid — got ${given.length ? given.join(" + ") : "none"}.`
      );
    }

    if (a.path !== undefined && a.path !== "") {
      if (!allowLocalFiles) {
        throw new Error(
          `${label}: "path" only works when the server runs locally over stdio. This is a remote server with no access to your files — ` +
            `pass the bytes as content_base64, or use from_uid to re-attach a file already in the mailbox.`
        );
      }
      let info;
      try {
        info = await stat(a.path);
      } catch {
        throw new Error(`${label}: cannot read "${a.path}" — no such file.`);
      }
      if (!info.isFile()) throw new Error(`${label}: "${a.path}" is not a file.`);
      if (info.size > MAX_ONE) throw new Error(`${label}: "${a.path}" is ${human(info.size)}; the per-file limit is ${human(MAX_ONE)}.`);
      out.push({
        filename: a.filename || basename(a.path),
        content: await readFile(a.path),
        contentType: a.content_type || undefined,
      });
      continue;
    }

    if (a.content_base64) {
      const content = Buffer.from(a.content_base64, "base64");
      if (!content.length) throw new Error(`${label}: content_base64 decoded to zero bytes — is it valid base64?`);
      if (content.length > MAX_ONE) throw new Error(`${label}: ${human(content.length)} exceeds the per-file limit of ${human(MAX_ONE)}.`);
      if (!a.filename) throw new Error(`${label}: filename is required when passing content_base64.`);
      out.push({ filename: a.filename, content, contentType: a.content_type || undefined });
      continue;
    }

    const picked = await fromMessage(withImap, {
      uid: a.from_uid,
      mailbox: a.from_mailbox,
      filename: a.from_filename,
    });
    for (const p of picked) {
      if (p.content.length > MAX_ONE) throw new Error(`${label}: "${p.filename}" is ${human(p.content.length)}; the per-file limit is ${human(MAX_ONE)}.`);
      out.push(a.filename && picked.length === 1 ? { ...p, filename: a.filename } : p);
    }
  }

  const total = out.reduce((n, x) => n + x.content.length, 0);
  if (total > maxTotal) {
    throw new Error(
      `attachments total ${human(total)}, over the ${human(maxTotal)} limit` +
        (maxTotal === MAX_SCHEDULED_TOTAL
          ? " for scheduled sends (EventBridge Scheduler caps the payload at 256 KB). Send it now instead of scheduling it, or attach something smaller."
          : ".")
    );
  }
  return out;
}

// One-line-per-attachment summary for send previews and read_message.
export const describe = (list) =>
  list.map((a) => `  • ${a.filename} (${typeOf(a)}, ${human(a.content?.length ?? a.size ?? 0)})`).join("\n");

export { human };
