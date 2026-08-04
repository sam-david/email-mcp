# email-mcp

A tiny, auditable [MCP](https://modelcontextprotocol.io) server that lets Claude
**read and send email over any IMAP/SMTP account** (Zoho, Gmail, Fastmail,
custom).

Built deliberately small so every line is reviewable — it's the one tool that
touches the mailbox.

## What it does (and doesn't)

- Connects **only** to the IMAP/SMTP hosts you configure. No other network I/O, no telemetry.
- Credentials come **only** from the environment or an external profile file —
  **never from inside this repo**. One install serves many mailboxes.
- Ships **dry-run ON** by default: `send_email` returns a preview instead of sending until you opt in.

### Tools

| Tool | Purpose |
|------|---------|
| `check_connection` | Verify IMAP login + SMTP readiness (no send); reports the active config source |
| `list_messages` | Recent messages in a mailbox (from/subject/date/uid) |
| `read_message` | Full text of one message by UID, plus any attachments it carries |
| `search_messages` | Keyword search across from/subject/body |
| `get_attachment` | Download one attachment from a message |
| `send_email` | Send mail, with attachments (respects dry-run) |
| `schedule_send` · `list_scheduled` · `cancel_scheduled` | Server-side scheduled sending (remote deployment only) |

### Attachments

The awkward question is *where the bytes come from*, and the answer differs by
transport, so each attachment names exactly one source:

| Source | Works where | Use it for |
|--------|-------------|------------|
| `path` | **stdio only** — the server is a local subprocess, so the filesystem is yours | attaching a file on your machine |
| `content_base64` | everywhere | content the model generated itself (a CSV, a report) — and the only option a claude.ai connector has |
| `from_uid` | everywhere | re-attaching a file already on a message in the mailbox (forwarding) |

```jsonc
// local: attach a file from disk
{ "attachments": [{ "path": "/Users/you/invoice.pdf" }] }

// anywhere: attach generated content
{ "attachments": [{ "filename": "q3.csv", "content_base64": "bmFtZSxjb3VudAo..." }] }

// forward what someone sent you
{ "attachments": [{ "from_uid": 8412, "from_filename": "contract.pdf" }] }
```

Over HTTP, `path` is **refused** rather than honoured: it would read the
*server's* disk on behalf of a remote caller. Fetching attachments from a URL is
deliberately not supported either — it would give any caller a general-purpose
outbound request and break the guarantee below.

Limits are **20 MB per file, 25 MB total** — the mail provider's ceiling, the
same one Mac Mail hits. Two exceptions, both documented in [TODO.md](TODO.md):

- `schedule_send` allows only **150 KB**, because deferred bytes currently wait
  inside an EventBridge Scheduler payload, which AWS caps at 256 KB.
- `content_base64` over the remote transport is bounded well below 25 MB in
  practice, since the bytes travel inside the tool call itself. Prefer `from_uid`
  for anything large.

## Configuration model — profiles

Credentials never live in this repo. Instead each mailbox is a **profile** file
stored under `~/.config/email-mcp/`, and each project registers this server
pointing at the profile it should use. So one clone of `email-mcp` can serve
many separate accounts.

Resolution order (the process environment always wins over file values):

1. `MAIL_ENV_FILE=/abs/path` → load that env file
2. `MAIL_PROFILE=name` → load `~/.config/email-mcp/<name>.env`
3. otherwise → rely purely on the process environment (e.g. inline `-e` vars)

### Setup

**1. Get a password.** Where your provider supports it, generate an
**app-specific password** rather than using your main one (e.g. Zoho Mail →
**Settings → Security → App Passwords**). Revoke it any time.

**2. Create a profile.** Copy `profile.env.example` to
`~/.config/email-mcp/<name>.env` (e.g. `dva.env`) and fill it in:

```
MAIL_EMAIL=you@yourdomain.com
MAIL_PASSWORD=your-app-password
MAIL_IMAP_HOST=imap.zoho.com      # or gmail/fastmail/etc.
MAIL_SMTP_HOST=smtp.zoho.com
```

`chmod 600` the file so it's owner-only.

**3. Register the server in your project**, pointing at that profile:

```bash
claude mcp add email -e MAIL_PROFILE=dva -- node /Users/sam/code/projects/email-mcp/src/index.mjs
```

Run this from inside the project's directory so it registers at **local** scope
(the default) — that way the same `email` tool name maps to the right mailbox
per project.

**4. Verify** — in Claude, run `check_connection`. You should see `IMAP OK`,
`SMTP OK`, and the config source.

**5. Go live** — once you've previewed a `send_email` in dry-run, set
`MAIL_DRY_RUN=false` in the profile to send for real.

### Multiple projects / mailboxes

```
~/.config/email-mcp/
├── dva.env         # hello@delawarevalleyaerial.com
└── acme.env        # ops@acme.com
```

In each project, register `email` with that project's profile:

```bash
# in ~/code/employment/delaware-valley-aerial
claude mcp add email -e MAIL_PROFILE=dva -- node /Users/sam/code/projects/email-mcp/src/index.mjs

# in ~/code/clients/acme
claude mcp add email -e MAIL_PROFILE=acme -- node /Users/sam/code/projects/email-mcp/src/index.mjs
```

One server, many mailboxes, zero secrets in the repo.

## Remote hosting

The server also speaks **Streamable HTTP** (`MCP_HTTP=1` or set `PORT`) so cloud
and scheduled Claude agents can reach it — see [`deploy/`](deploy/README.md) for
the AWS App Runner setup.

Two ways in, both checked against the same per-profile bearer token:

- **Static bearer** — Claude Code (`--header "Authorization: Bearer …"`) and the
  Messages API MCP connector (`authorization_token`).
- **OAuth 2.1** — claude.ai / Claude Desktop custom connectors, whose UI has no
  header field. The server is its own authorization server (`src/oauth.mjs`):
  RFC 9728 protected-resource metadata, RFC 8414 AS metadata, RFC 7591 dynamic
  client registration, and a PKCE (S256) code flow. The consent page asks for
  that same bearer token, so there's no second credential to manage.

Registrations, authorization codes and tokens are stateless HMAC blobs signed
with a key derived from the profile's bearer — no database, and rotating a
bearer revokes every token issued for that mailbox.

## Provider hosts

| Provider | IMAP | SMTP |
|----------|------|------|
| Zoho (standard) | imap.zoho.com | smtp.zoho.com |
| Zoho (custom-domain / pro) | imappro.zoho.com | smtppro.zoho.com |
| Gmail | imap.gmail.com | smtp.gmail.com |
| Fastmail | imap.fastmail.com | smtp.fastmail.com |

## Security notes

- Profiles live under `~/.config/email-mcp/` (outside any repo); `chmod 600` them.
- Prefer an app-specific password → revoke it any time without touching your main login.
- Claude will always show you an email and get your OK before sending.
