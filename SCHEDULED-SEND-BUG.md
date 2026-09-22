# Bug: scheduled sends fail silently in local (stdio) mode

**Found 2026-09-21. Severity: high — 13 business emails were lost with no error
surfaced to the caller.**

## What happened

13 emails were queued with `schedule_send` on Fri 19 Sep for Mon 21 Sep,
09:15–11:16 ET. `list_scheduled` confirmed all 13 were queued. On Monday:

- none arrived
- nothing appeared in the Zoho Sent folder
- `list_scheduled` returned empty
- no error reached the MCP caller

## Root cause

Two independent defects compound into silent data loss.

### 1. Profile resolves to `default` in local stdio mode

`src/server.mjs:585`

```js
const profileName = () => {
  const m = /secretsmanager:.*\/([^/]+)$/.exec(source);
  return m ? m[1] : process.env.MAIL_PROFILE || "default";
};
```

In cloud mode `source` is a Secrets Manager ARN, so the regex yields the real
profile. In local stdio mode `source` is a filesystem path
(`/Users/sam/code/employment/delaware-valley-aerial/.env.email`), the regex
misses, and `MAIL_PROFILE` is **not set** in that env file — it appears only in
a comment. So `profileName()` returns `"default"`.

That value goes into both the schedule name and the Lambda payload
(`src/server.mjs:635` and `:659`):

    emailmcp-default-<uuid>
    Input: { profile: "default", ... }

### 2. The worker cannot resolve `default`, and the schedule deletes itself

`lambda/worker/index.mjs:62`

```js
const res = await sm.send(new GetSecretValueCommand({ SecretId: `${PREFIX}${profile}` }));
```

resolves to `email-mcp/default`, which does not exist. Existing secrets are
`email-mcp/dva` and `email-mcp/two-hens`. The handler throws:

    ResourceNotFoundException: Secrets Manager can't find the specified secret.
    at async Runtime.handler (file:///var/task/index.mjs:62:15)

EventBridge retried (13:15:23, 13:16:23, 13:18:11 …), exhausted retries, and
`ActionAfterCompletion: "DELETE"` then removed the schedule. The queue emptied,
so `list_scheduled` showed nothing and the failure left no trace anywhere the
caller could see.

## Why it looked like it worked

`send_email` runs in-process against SMTP and appends to IMAP Sent — it has
always worked. Only `schedule_send` goes via EventBridge → Lambda → Secrets
Manager. Earlier scheduled-send tests (29 Jul, 4 Aug) predate whatever changed
here and did land in Sent, which made the path look proven.

## Fixes

**Immediate (done):** `MAIL_PROFILE=dva` added to the DVA `.env.email`.
Requires an MCP restart to take effect, since env is read at startup.

**Code — in rough priority order:**

1. **Validate at schedule time, not fire time.** `schedule_send` should confirm
   the target secret is resolvable before creating the schedule, and return an
   error to the caller if not. Queueing a send that cannot possibly succeed is
   the core defect.
2. **Do not delete a schedule that failed.** `ActionAfterCompletion: "DELETE"`
   should apply on success only; add a DLQ or Lambda on-failure destination so
   failures are visible. Right now a failed send is indistinguishable from a
   delivered one.
3. **Fail loudly when the profile is unresolvable.** Silently falling back to
   `"default"` is dangerous when the fallback maps to a nonexistent secret. In
   local mode, either require `MAIL_PROFILE` before allowing `schedule_send`,
   or refuse to schedule at all.
4. **Surface failures back through the MCP.** `list_scheduled` cannot currently
   distinguish "sent", "pending" and "died". Consider a status field, or a
   `list_failed`.

## Reproduce

```
MAIL_PROFILE unset, local stdio, SECRETS_PREFIX unset locally
→ schedule_send  → schedule named emailmcp-default-*
→ at fire time   → ResourceNotFoundException, schedule self-deletes
```

Worker logs: CloudWatch `/aws/lambda/email-mcp-send-worker`, us-east-1,
account 394560206879.
