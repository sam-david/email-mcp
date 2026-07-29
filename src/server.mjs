// Builds an MCP server bound to a specific mail config. Stateless — safe to
// create once (stdio) or one per request (HTTP).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";

const text = (t) => ({ content: [{ type: "text", text: t }] });
const senderName = (env) =>
  env?.from?.[0] ? (env.from[0].name || env.from[0].address) : "(unknown)";

export function createServer(cfg, source = "process environment") {
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
        const head = [
          `From: ${p.from?.text || "?"}`,
          `To: ${p.to?.text || "?"}`,
          `Date: ${p.date ? p.date.toLocaleString() : "?"}`,
          `Subject: ${p.subject || "(no subject)"}`,
        ].join("\n");
        return text(`${head}\n\n${(p.text || p.html || "(no body)").trim()}`);
      })
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
        "Send an email from the configured account. Honors MAIL_DRY_RUN — when on, returns a preview instead of sending.",
      inputSchema: {
        to: z.string().describe("Recipient address(es), comma-separated"),
        subject: z.string(),
        body: z.string().describe("Plain-text body"),
        cc: z.string().optional(),
        bcc: z.string().optional(),
        html: z.string().optional().describe("Optional HTML body"),
      },
    },
    async ({ to, subject, body, cc, bcc, html }) => {
      assertCreds();
      const from = cfg.fromName ? `"${cfg.fromName}" <${cfg.fromAddress}>` : cfg.fromAddress;
      const preview = [
        `From: ${from}`,
        `To: ${to}`,
        cc ? `Cc: ${cc}` : null,
        bcc ? `Bcc: ${bcc}` : null,
        `Subject: ${subject}`,
        "",
        body,
      ]
        .filter((l) => l !== null)
        .join("\n");
      if (cfg.dryRun) {
        return text(`DRY RUN — not sent. Set MAIL_DRY_RUN=false to send for real.\n\n${preview}`);
      }
      const info = await smtpTransport().sendMail({ from, to, cc, bcc, subject, text: body, html });
      return text(`Sent ✓ (${info.messageId})\n\n${preview}`);
    }
  );

  return server;
}
