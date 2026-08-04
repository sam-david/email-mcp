// Builds an MCP server bound to a specific mail config. Stateless — safe to
// create once (stdio) or one per request (HTTP).
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";
import {
  SchedulerClient,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  ListSchedulesCommand,
} from "@aws-sdk/client-scheduler";
import { sendMail } from "./send.mjs";
import {
  resolveAttachments,
  describe as describeAttachments,
  human,
  MAX_ONE,
  MAX_SCHEDULED_TOTAL,
} from "./attachments.mjs";

const text = (t) => ({ content: [{ type: "text", text: t }] });
const senderName = (env) =>
  env?.from?.[0] ? (env.from[0].name || env.from[0].address) : "(unknown)";

// One attachment. Exactly one byte-source per entry — see attachments.mjs.
const attachmentSchema = z.object({
  filename: z.string().optional().describe("Name the recipient sees. Required with content_base64; otherwise defaults to the source's own name."),
  path: z.string().optional().describe("Absolute path to a local file. Only works when this server runs locally over stdio."),
  content_base64: z
    .string()
    .optional()
    .describe(
      "The file's bytes, base64-encoded. Use for content you generated yourself, and keep it small — this travels inside the tool call, so anything above a few hundred KB is slow and may be rejected outright. To attach a large file that is already in the mailbox, use from_uid instead."
    ),
  content_type: z.string().optional().describe("MIME type; inferred from the filename when omitted."),
  from_uid: z.number().int().optional().describe("Re-attach files from an existing message with this UID (forwarding)."),
  from_mailbox: z.string().optional().describe("Mailbox holding from_uid, default INBOX."),
  from_filename: z.string().optional().describe("Which attachment on that message; omit to take all of them."),
});

// `allowLocalFiles` is true only for the stdio transport, where the server is a
// subprocess on the user's own machine. See attachments.mjs.
export function createServer(cfg, source = "process environment", { allowLocalFiles = false } = {}) {
  function assertCreds() {
    if (!cfg.email || !cfg.pass) {
      throw new Error(`Missing MAIL_EMAIL or MAIL_PASSWORD (config source: ${source}).`);
    }
  }

  async function withImap(fn) {
    assertCreds();
    const client = new ImapFlow({
      host: cfg.imapHost,
      port: cfg.imapPort,
      secure: true,
      auth: { user: cfg.email, pass: cfg.pass },
      logger: false,
    });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      try { await client.logout(); } catch { /* ignore */ }
    }
  }

  function smtpTransport() {
    assertCreds();
    return nodemailer.createTransport({
      host: cfg.smtpHost,
      port: cfg.smtpPort,
      secure: cfg.smtpPort === 465,
      auth: { user: cfg.email, pass: cfg.pass },
    });
  }

  const server = new McpServer({ name: "email-mcp", version: "1.1.0" });

  server.registerTool(
    "check_connection",
    {
      title: "Check connection",
      description: "Verify IMAP login + SMTP readiness without sending anything. Run this after setup.",
      inputSchema: {},
    },
    async () => {
      const out = [];
      try {
        await withImap(async (c) => {
          const mb = await c.mailboxOpen("INBOX", { readOnly: true });
          out.push(`IMAP OK — ${cfg.email} @ ${cfg.imapHost}:${cfg.imapPort} (INBOX: ${mb.exists} messages)`);
        });
      } catch (e) {
        return text(
          `IMAP FAILED (${cfg.email} @ ${cfg.imapHost}:${cfg.imapPort}): ` +
            `${e.responseText || e.serverResponseCode || e.code || e.message}` +
            (e.authenticationFailed ? " — authentication failed; check the app password" : "")
        );
      }
      try {
        await new Promise((res, rej) => smtpTransport().verify((e) => (e ? rej(e) : res())));
      } catch (e) {
        return text(`IMAP OK, but SMTP FAILED (${cfg.smtpHost}:${cfg.smtpPort}): ${e.response || e.message}`);
      }
      out.push(`SMTP OK — ${cfg.smtpHost}:${cfg.smtpPort}`);
      out.push(
        `Sending as: ${cfg.fromAddress}` +
          (cfg.fromAddress !== cfg.email ? ` (alias; auth as ${cfg.email})` : "")
      );
      out.push(`Config source: ${source}`);
      out.push(`Dry-run: ${cfg.dryRun ? "ON — send_email previews only" : "OFF — emails send for real"}`);
      return text(out.join("\n"));
    }
  );

  server.registerTool(
    "list_messages",
    {
      title: "List recent messages",
      description: "List recent messages in a mailbox (default INBOX) with from / subject / date / uid.",
      inputSchema: {
        mailbox: z.string().optional().describe("Mailbox name, default INBOX"),
        limit: z.number().int().min(1).max(100).optional().describe("How many recent messages (default 20)"),
        unseen_only: z.boolean().optional().describe("Only unread messages"),
      },
    },
    async ({ mailbox = "INBOX", limit = 20, unseen_only = false }) =>
      withImap(async (c) => {
        const mb = await c.mailboxOpen(mailbox, { readOnly: true });
        if (!mb.exists) return text(`(${mailbox} is empty)`);
        const uids = unseen_only ? await c.search({ seen: false }, { uid: true }) : null;
        if (unseen_only && (!uids || !uids.length)) return text("(no unread messages)");
        const range = uids ? uids.slice(-limit) : `${Math.max(1, mb.exists - limit + 1)}:*`;
        const opts = uids ? { uid: true } : undefined;
        const rows = [];
        for await (const msg of c.fetch(range, { envelope: true, flags: true, uid: true }, opts)) {
          const seen = msg.flags?.has ? msg.flags.has("\\Seen") : false;
          const when = msg.envelope?.date ? new Date(msg.envelope.date).toLocaleString() : "?";
          rows.push(`[uid ${msg.uid}] ${seen ? " " : "•"} ${senderName(msg.envelope)} — ${msg.envelope?.subject || "(no subject)"}  (${when})`);
        }
        rows.reverse(); // newest first
        return text(rows.length ? rows.join("\n") : "(no messages)");
      })
  );

  server.registerTool(
    "read_message",
    {
      title: "Read a message",
      description: "Fetch and return the full text of a message by its UID (from list_messages / search_messages).",
      inputSchema: {
        uid: z.number().int().describe("Message UID"),
        mailbox: z.string().optional().describe("Mailbox, default INBOX"),
      },
    },
    async ({ uid, mailbox = "INBOX" }) =>
      withImap(async (c) => {
        await c.mailboxOpen(mailbox, { readOnly: true });
        const msg = await c.fetchOne(uid, { source: true }, { uid: true });
        if (!msg || !msg.source) return text(`(no message with uid ${uid} in ${mailbox})`);
        const p = await simpleParser(msg.source);
        const files = p.attachments || [];
        const head = [
          `From: ${p.from?.text || "?"}`,
          `To: ${p.to?.text || "?"}`,
          `Date: ${p.date ? p.date.toLocaleString() : "?"}`,
          `Subject: ${p.subject || "(no subject)"}`,
          // Surface attachments by name — otherwise the message reads as if it
          // had none, and they can be forwarded via send_email's from_uid.
          files.length ? `Attachments (${files.length}):\n${describeAttachments(files)}` : null,
        ]
          .filter((l) => l !== null)
          .join("\n");
        return text(`${head}\n\n${(p.text || p.html || "(no body)").trim()}`);
      })
  );

  server.registerTool(
    "get_attachment",
    {
      title: "Download an attachment",
      description:
        "Fetch one attachment from a message. Saves it to disk when save_to is given (local server only); otherwise returns its bytes base64-encoded.",
      inputSchema: {
        uid: z.number().int().describe("Message UID (from list_messages / search_messages)"),
        filename: z.string().optional().describe("Which attachment; omit if the message has only one"),
        mailbox: z.string().optional().describe("Mailbox, default INBOX"),
        save_to: z.string().optional().describe("Absolute path to write the file to. Only works when this server runs locally over stdio."),
      },
    },
    async ({ uid, filename, mailbox = "INBOX", save_to }) => {
      const files = await withImap(async (c) => {
        await c.mailboxOpen(mailbox, { readOnly: true });
        const msg = await c.fetchOne(uid, { source: true }, { uid: true });
        if (!msg || !msg.source) throw new Error(`no message with uid ${uid} in ${mailbox}`);
        return (await simpleParser(msg.source)).attachments || [];
      });
      if (!files.length) return text(`Message uid ${uid} has no attachments.`);
      const named = files.map((f) => f.filename || "(unnamed)");
      const picked = filename ? files.find((f) => f.filename === filename) : files.length === 1 ? files[0] : null;
      if (!picked) {
        return text(
          filename
            ? `No attachment named "${filename}" on uid ${uid}. It has: ${named.join(", ")}`
            : `Message uid ${uid} has ${files.length} attachments — name one: ${named.join(", ")}`
        );
      }

      if (save_to) {
        if (!allowLocalFiles) {
          return text(
            "save_to only works when the server runs locally over stdio — this is a remote server, and writing to its disk wouldn't give you the file. Omit save_to to get the bytes instead."
          );
        }
        await writeFile(save_to, picked.content);
        return text(`Saved ${picked.filename} (${human(picked.content.length)}) to ${save_to}`);
      }

      if (picked.content.length > MAX_ONE) {
        return text(`${picked.filename} is ${human(picked.content.length)} — too large to return inline (limit ${human(MAX_ONE)}).`);
      }
      return text(
        `${picked.filename} (${picked.contentType || "application/octet-stream"}, ${human(picked.content.length)}), base64:\n\n` +
          picked.content.toString("base64")
      );
    }
  );

  server.registerTool(
    "search_messages",
    {
      title: "Search messages",
      description: "Search a mailbox by keyword across from / subject / body.",
      inputSchema: {
        query: z.string().describe("Keyword to search for"),
        mailbox: z.string().optional().describe("Mailbox, default INBOX"),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ query, mailbox = "INBOX", limit = 20 }) =>
      withImap(async (c) => {
        await c.mailboxOpen(mailbox, { readOnly: true });
        const uids = await c.search({ or: [{ from: query }, { subject: query }, { body: query }] }, { uid: true });
        if (!uids || !uids.length) return text(`(no matches for "${query}")`);
        const rows = [];
        for await (const msg of c.fetch(uids.slice(-limit), { envelope: true, uid: true }, { uid: true })) {
          const when = msg.envelope?.date ? new Date(msg.envelope.date).toLocaleDateString() : "?";
          rows.push(`[uid ${msg.uid}] ${senderName(msg.envelope)} — ${msg.envelope?.subject || "(no subject)"}  (${when})`);
        }
        rows.reverse();
        return text(rows.join("\n"));
      })
  );

  server.registerTool(
    "send_email",
    {
      title: "Send an email",
      description:
        "Send an email from the configured account, optionally with attachments. Honors MAIL_DRY_RUN — when on, returns a preview instead of sending.",
      inputSchema: {
        to: z.string().describe("Recipient address(es), comma-separated"),
        subject: z.string(),
        body: z.string().describe("Plain-text body"),
        cc: z.string().optional(),
        bcc: z.string().optional(),
        html: z.string().optional().describe("Optional HTML body"),
        attachments: z.array(attachmentSchema).optional().describe("Files to attach"),
      },
    },
    async ({ to, subject, body, cc, bcc, html, attachments }) => {
      assertCreds();
      const files = await resolveAttachments(attachments, { allowLocalFiles, withImap });
      const from = cfg.fromName ? `"${cfg.fromName}" <${cfg.fromAddress}>` : cfg.fromAddress;
      const preview = [
        `From: ${from}`,
        `To: ${to}`,
        cc ? `Cc: ${cc}` : null,
        bcc ? `Bcc: ${bcc}` : null,
        `Subject: ${subject}`,
        files.length ? `Attachments (${files.length}):\n${describeAttachments(files)}` : null,
        "",
        body,
      ]
        .filter((l) => l !== null)
        .join("\n");
      if (cfg.dryRun) {
        return text(`DRY RUN — not sent. Set MAIL_DRY_RUN=false to send for real.\n\n${preview}`);
      }
      const info = await sendMail(cfg, { to, subject, body, cc, bcc, html, attachments: files });
      return text(`Sent ✓ (${info.messageId})\n\n${preview}`);
    }
  );

  // ---- scheduled send: EventBridge Scheduler → send-worker Lambda ----
  // Durable + server-side: fires at the target time whether or not any client
  // is connected. Configured via env (set by Terraform on the host); inert locally.
  const SCHED = {
    workerArn: process.env.WORKER_LAMBDA_ARN,
    roleArn: process.env.SCHEDULER_ROLE_ARN,
    group: process.env.SCHEDULER_GROUP || "default",
  };
  const schedulingOn = () => Boolean(SCHED.workerArn && SCHED.roleArn);
  const profileName = () => {
    const m = /secretsmanager:.*\/([^/]+)$/.exec(source);
    return m ? m[1] : process.env.MAIL_PROFILE || "default";
  };
  const scheduler = () => new SchedulerClient({});

  server.registerTool(
    "schedule_send",
    {
      title: "Schedule an email to send later",
      description:
        "Queue an email to be sent at a future time — durable and server-side, independent of any client. send_at is ISO 8601 (UTC recommended, e.g. 2026-08-01T14:30:00Z).",
      inputSchema: {
        to: z.string().describe("Recipient address(es), comma-separated"),
        subject: z.string(),
        body: z.string().describe("Plain-text body"),
        send_at: z.string().describe("When to send, ISO 8601 (e.g. 2026-08-01T14:30:00Z)"),
        cc: z.string().optional(),
        bcc: z.string().optional(),
        html: z.string().optional(),
        attachments: z
          .array(attachmentSchema)
          .optional()
          .describe(`Files to attach. Read at schedule time, and limited to ${human(MAX_SCHEDULED_TOTAL)} total — much smaller than for an immediate send.`),
      },
    },
    async ({ to, subject, body, send_at, cc, bcc, html, attachments }) => {
      if (!schedulingOn()) return text("Scheduling isn't configured on this server (no worker Lambda / role).");
      const when = new Date(send_at);
      if (isNaN(when.getTime())) return text(`Invalid send_at "${send_at}". Use ISO 8601, e.g. 2026-08-01T14:30:00Z.`);
      if (when.getTime() <= Date.now() + 60_000) return text("send_at must be at least a minute in the future.");

      // Resolve to bytes NOW and carry them in the schedule payload: at fire
      // time the Lambda has no access to a local path, and the source message
      // may have moved or been deleted.
      const files = await resolveAttachments(attachments, {
        allowLocalFiles,
        withImap,
        maxTotal: MAX_SCHEDULED_TOTAL,
      });

      const from = cfg.fromName ? `"${cfg.fromName}" <${cfg.fromAddress}>` : cfg.fromAddress;
      const preview =
        `From: ${from}\nTo: ${to}\nSubject: ${subject}\nSend at: ${when.toISOString()}` +
        (files.length ? `\nAttachments (${files.length}):\n${describeAttachments(files)}` : "") +
        `\n\n${body}`;
      if (cfg.dryRun) return text(`DRY RUN — not scheduled. Set MAIL_DRY_RUN=false to schedule for real.\n\n${preview}`);
      const name = `emailmcp-${profileName()}-${randomUUID()}`;
      await scheduler().send(
        new CreateScheduleCommand({
          Name: name,
          GroupName: SCHED.group,
          ScheduleExpression: `at(${when.toISOString().slice(0, 19)})`, // yyyy-mm-ddThh:mm:ss
          ScheduleExpressionTimezone: "UTC",
          FlexibleTimeWindow: { Mode: "OFF" },
          ActionAfterCompletion: "DELETE", // self-clean after it fires
          Target: {
            Arn: SCHED.workerArn,
            RoleArn: SCHED.roleArn,
            Input: JSON.stringify({
              profile: profileName(),
              to,
              subject,
              body,
              cc,
              bcc,
              html,
              ...(files.length
                ? {
                    attachments: files.map((f) => ({
                      filename: f.filename,
                      content_base64: f.content.toString("base64"),
                      content_type: f.contentType,
                    })),
                  }
                : {}),
            }),
          },
        })
      );
      return text(`Scheduled ✓ — sends at ${when.toISOString()}\nid: ${name}\n\n${preview}`);
    }
  );

  server.registerTool(
    "list_scheduled",
    { title: "List scheduled sends", description: "List pending scheduled emails for this mailbox.", inputSchema: {} },
    async () => {
      if (!schedulingOn()) return text("Scheduling isn't configured on this server.");
      const out = await scheduler().send(
        new ListSchedulesCommand({ GroupName: SCHED.group, NamePrefix: `emailmcp-${profileName()}-` })
      );
      const names = (out.Schedules || []).map((s) => s.Name);
      return text(names.length ? names.join("\n") : "(no scheduled sends)");
    }
  );

  server.registerTool(
    "cancel_scheduled",
    {
      title: "Cancel a scheduled send",
      description: "Cancel a pending scheduled email by its id (from schedule_send / list_scheduled).",
      inputSchema: { id: z.string().describe("The schedule id (name)") },
    },
    async ({ id }) => {
      if (!schedulingOn()) return text("Scheduling isn't configured on this server.");
      await scheduler().send(new DeleteScheduleCommand({ Name: id, GroupName: SCHED.group }));
      return text(`Canceled ${id}`);
    }
  );

  return server;
}
