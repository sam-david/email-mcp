# Follow-ups

Known gaps, with the reasoning captured so they don't have to be re-derived.

## ~~1. Large attachments on `schedule_send`~~ — done

Scheduled attachments now spool to `s3://<bucket>/pending/<schedule-id>/` and
the payload carries keys instead of bytes, so `schedule_send` matches
`send_email` at 25 MB. The worker fetches on invoke and deletes the prefix after
delivering; a lifecycle rule sweeps whatever cancelled or failed schedules leave
behind. See `src/storage.mjs` and `deploy/terraform/storage.tf`.

## ~~2. Getting large files into a remote send~~ — mostly done

Named assets (`assets/<name>` in the same bucket) cover the recurring case: a
pricing sheet is uploaded once with `deploy/asset.sh` and referenced as
`{ "asset": "pricing-sheet" }` thereafter, so the bytes never travel through a
tool call.

Still open: **an arbitrary one-off large file from claude.ai.** `content_base64`
remains bounded — App Runner caps request bodies at 10 MB, and long before that
the base64 is model output, so a few hundred KB is the practical ceiling. That
is inherent to passing bytes through a tool call. If it ever matters, the answer
is a presigned S3 PUT URL the user uploads to directly, with the resulting key
usable as an attachment source. The bucket and IAM for it already exist.

## 3. Untested against a live mailbox

- `send_email` with `content_base64` — **verified** 2026-08-04 (CSV round trip)
- `read_message` attachment listing — **verified** 2026-08-04
- `get_attachment` — **verified** 2026-08-04, bytes identical
- `from_uid` forwarding — still unexercised; `uid 22` in `Sent` has an
  attachment to test against

## 4. Asset storage is remote-only

`storageOn()` keys off `ASSETS_BUCKET`, which only the App Runner deployment
sets. So `asset`, `list_assets` and `save_asset` report as unconfigured from a
local stdio install. That is the safe default (a local install shouldn't need
AWS credentials), but if it becomes annoying, setting `ASSETS_BUCKET` plus an
AWS profile in the local `~/.config/email-mcp/<name>.env` makes them work
locally too — `save_asset` with a `path` would then be the nicest way to upload,
since stdio already allows local files.

## 5. Deployment sharp edges

- `docker build -t "$REPO:latest"` **silently mis-tags under zsh**: `:l` is the
  lowercase modifier, so it builds `<repo>atest:latest`. Always brace it:
  `"${REPO}:latest"`.
- Pushing the image and running `terraform apply` both trigger an App Runner
  deployment, and the service rejects a second one while the first is running.
  Push, wait for `RUNNING`, then apply.
- Build with `--platform linux/amd64` on Apple Silicon; the service is x86_64.
