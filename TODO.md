# Follow-ups

Known gaps, with the reasoning captured so they don't have to be re-derived.

## 1. Large attachments on `schedule_send` (S3 spool)

**Now:** `schedule_send` accepts at most **150 KB** of attachments, while
`send_email` accepts 25 MB. Anything bigger fails with an explanatory error.

**Why:** deferred sending has to park the bytes somewhere server-side until the
schedule fires. They currently ride inside the EventBridge Scheduler payload,
and **AWS caps `Target.Input` at 256 KB**
([API ref](https://docs.aws.amazon.com/scheduler/latest/APIReference/API_Target.html)).
Nothing to do with SMTP or the mail provider — just the wrong parking spot for a
document.

**Fix:** spool to S3 instead.

- `schedule_send` writes each resolved attachment to `s3://<bucket>/pending/<schedule-id>/<n>`
  and puts the keys (not the bytes) in the schedule payload.
- The worker Lambda fetches them on invoke, then deletes the prefix.
- Terraform: one bucket, private, SSE, plus a lifecycle rule expiring
  `pending/` after ~30 days so cancelled or failed schedules can't accumulate.
  Worker role needs `s3:GetObject`/`s3:DeleteObject`; the App Runner instance
  role needs `s3:PutObject`, both scoped to that prefix.
- Then `MAX_SCHEDULED_TOTAL` in `src/attachments.mjs` can just become `MAX_TOTAL`.

Roughly 40 lines plus the Terraform. Worth doing only if scheduled sends will
ever carry a real document — skip it if they stay text-only.

## 2. Getting large files *into* a remote send from claude.ai

**Now:** over the remote HTTP transport the practical routes are:

| Route | Ceiling | Why |
|-------|---------|-----|
| `from_uid` (re-attach from the mailbox) | ~20 MB | bytes go IMAP → SMTP, never leave AWS |
| `content_base64` | **~7.5 MB hard, a few hundred KB realistically** | see below |
| `path` | n/a | refused over HTTP by design — it would read the server's disk |

`content_base64` travels *inside the MCP tool call*, which means:

- **App Runner caps request bodies at 10 MB**, so ~7.5 MB of file after base64's
  33% inflation — and that request is rejected upstream, before this server can
  return a useful error.
- Long before that, the base64 is being emitted as model output. A 5 MB file is
  6.7 MB of text in one tool call. This is inherent to passing bytes through a
  tool call and cannot be raised by changing anything here.

So "upload a big file in claude.ai and email it" does not work today, and won't
via this route. It needs a separate ingestion path — most likely a tool that
returns a **presigned S3 PUT URL** for the user to upload to directly, with
`send_email` then accepting an `from_s3_key`. Design it alongside #1, since it
wants the same bucket.

Not a problem for Claude Code, where `path` reads from disk and never touches
HTTP.

## 3. Untested against a live mailbox

`from_uid` and `get_attachment` are covered by unit tests only — resolving them
needs real IMAP credentials. Exercise both against the DVA inbox once:
read a message with an attachment, forward it, download it.
