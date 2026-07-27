# email-mcp

A tiny, auditable [MCP](https://modelcontextprotocol.io) server that lets Claude
**read and send email over any IMAP/SMTP account** (Zoho, Gmail, Fastmail,
custom — just point the hosts in `.env`).

Built deliberately small so every line is reviewable — it's the one tool that
touches the mailbox.

## What it does (and doesn't)

- Connects **only** to the IMAP/SMTP hosts you configure. No other network I/O, no telemetry.
- Credentials come **only** from `.env` / environment — never hard-coded, never logged. `.env` is gitignored.
- Ships **dry-run ON** by default: `send_email` returns a preview instead of sending until you opt in.

### Tools

| Tool | Purpose |
|------|---------|
| `check_connection` | Verify IMAP login + SMTP readiness (no send) |
| `list_messages` | Recent messages in a mailbox (from/subject/date/uid) |
| `read_message` | Full text of one message by UID |
| `search_messages` | Keyword search across from/subject/body |
| `send_email` | Send mail (respects dry-run) |

## Setup

**1. Get a password.** Where your provider supports it, generate an
**app-specific password** rather than using your main one (e.g. Zoho Mail →
**Settings → Security → App Passwords**). You can revoke it any time.

**2. Configure `.env`** (copy `.env.example` if needed):

```
MAIL_EMAIL=you@yourdomain.com
MAIL_PASSWORD=your-app-password
MAIL_IMAP_HOST=imap.zoho.com      # or gmail/fastmail/etc.
MAIL_SMTP_HOST=smtp.zoho.com
```

**3. Register with Claude Code:**

```bash
claude mcp add email -- node /Users/sam/code/projects/email-mcp/src/index.mjs
```

**4. Verify** — in Claude, run the `check_connection` tool. You should see
`IMAP OK` and `SMTP OK`.

**5. Go live** — once you've previewed a `send_email` in dry-run, set
`MAIL_DRY_RUN=false` in `.env` to send for real.

## Provider hosts

| Provider | IMAP | SMTP |
|----------|------|------|
| Zoho (standard) | imap.zoho.com | smtp.zoho.com |
| Zoho (custom-domain / pro) | imappro.zoho.com | smtppro.zoho.com |
| Gmail | imap.gmail.com | smtp.gmail.com |
| Fastmail | imap.fastmail.com | smtp.fastmail.com |

## Security notes

- Prefer an app-specific password → revoke it any time without touching your main login.
- Claude will always show you an email and get your OK before sending.
