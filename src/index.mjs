#!/usr/bin/env node
// email-mcp — a minimal MCP server for reading and sending email over any
// IMAP/SMTP account (Zoho, Gmail, Fastmail, custom).
// Credentials come ONLY from the environment or an external profile/env file —
// never from inside this repo, so one install serves many projects/accounts.
// Connects ONLY to the configured mail hosts. No telemetry, no other network I/O.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";

// ---- credential resolution (no secrets ever live in this repo) ----
// Load order — the process environment always wins over file values:
//   1. MAIL_ENV_FILE=/path/to/file  → load that env file
//   2. MAIL_PROFILE=name            → load ~/.config/email-mcp/<name>.env
//   3. otherwise                    → rely purely on the process environment
// Each project registers this server with its own MAIL_PROFILE (or inline -e
// vars), so per-mailbox credentials stay OUTSIDE this shared server directory.
function loadEnvFile(path) {
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) {
        let v = m[2];
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        process.env[m[1]] = v;
      }
    }
    return true;
  } catch {
    return false;
  }
}

const expandHome = (p) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

let configSource = "process environment";
if (process.env.MAIL_ENV_FILE) {
  const path = expandHome(process.env.MAIL_ENV_FILE);
  configSource = loadEnvFile(path) ? path : `${path} (NOT FOUND)`;
} else if (process.env.MAIL_PROFILE) {
  const path = join(homedir(), ".config", "email-mcp", `${process.env.MAIL_PROFILE}.env`);
  configSource = loadEnvFile(path) ? path : `${path} (NOT FOUND)`;
}

const CFG = {
  email: process.env.MAIL_EMAIL, // login / authenticated account
  pass: process.env.MAIL_PASSWORD,
  fromName: process.env.MAIL_FROM_NAME || "",
  // From address on outgoing mail; defaults to the login address. Set to a
  // verified alias (e.g. sam@…) to send as that identity while still
  // authenticating as MAIL_EMAIL.
  fromAddress: process.env.MAIL_FROM_ADDRESS || process.env.MAIL_EMAIL,
  imapHost: process.env.MAIL_IMAP_HOST || "imap.zoho.com",
  imapPort: Number(process.env.MAIL_IMAP_PORT || 993),
  smtpHost: process.env.MAIL_SMTP_HOST || "smtp.zoho.com",
  smtpPort: Number(process.env.MAIL_SMTP_PORT || 465),
  dryRun: String(process.env.MAIL_DRY_RUN || "true").toLowerCase() !== "false",
};

function assertCreds() {
  if (!CFG.email || !CFG.pass) {
    throw new Error(
      `Missing MAIL_EMAIL or MAIL_PASSWORD (config source: ${configSource}). ` +
        "Set MAIL_PROFILE and create ~/.config/email-mcp/<profile>.env, or pass credentials as env vars."
    );
  }
}

async function withImap(fn) {
  assertCreds();
  const client = new ImapFlow({
    host: CFG.imapHost,
    port: CFG.imapPort,
    secure: true,
    auth: { user: CFG.email, pass: CFG.pass },
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
    host: CFG.smtpHost,
    port: CFG.smtpPort,
    secure: CFG.smtpPort === 465,
    auth: { user: CFG.email, pass: CFG.pass },
  });
}

const text = (t) => ({ content: [{ type: "text", text: t }] });
const senderName = (env) =>
  env?.from?.[0] ? (env.from[0].name || env.from[0].address) : "(unknown)";

const server = new McpServer({ name: "email-mcp", version: "1.0.0" });

server.registerTool(
  "check_connection",
  {
    title: "Check connection",
    description: "Verify Zoho IMAP login and SMTP readiness without sending anything. Run this after setup.",
    inputSchema: {},
  },
  async () => {
    const out = [];
    await withImap(async (c) => {
      const mb = await c.mailboxOpen("INBOX", { readOnly: true });
      out.push(`IMAP OK — ${CFG.email} @ ${CFG.imapHost}:${CFG.imapPort} (INBOX: ${mb.exists} messages)`);
    });
    await new Promise((res, rej) => smtpTransport().verify((e) => (e ? rej(e) : res())));
    out.push(`SMTP OK — ${CFG.smtpHost}:${CFG.smtpPort}`);
    out.push(
      `Sending as: ${CFG.fromAddress}` +
        (CFG.fromAddress !== CFG.email ? ` (alias; auth as ${CFG.email})` : "")
    );
    out.push(`Config source: ${configSource}`);
    out.push(`Dry-run: ${CFG.dryRun ? "ON — send_email previews only" : "OFF — emails send for real"}`);
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
    const from = CFG.fromName ? `"${CFG.fromName}" <${CFG.fromAddress}>` : CFG.fromAddress;
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
    if (CFG.dryRun) {
      return text(`DRY RUN — not sent. Set MAIL_DRY_RUN=false in .env to send for real.\n\n${preview}`);
    }
    const info = await smtpTransport().sendMail({ from, to, cc, bcc, subject, text: body, html });
    return text(`Sent ✓ (${info.messageId})\n\n${preview}`);
  }
);

await server.connect(new StdioServerTransport());
