#!/usr/bin/env bash
# Populate a mailbox secret (email-mcp/<profile>) in AWS Secrets Manager from a
# local KEY=VALUE env file. The password is read straight from the file into
# JSON (via Python) — never typed, printed, or shell-mangled. The bearer token
# is pulled from terraform output.
#
# Usage:
#   ./populate-profile.sh <profile> <env-file>
# Example:
#   ./populate-profile.sh dva ~/code/employment/delaware-valley-aerial/.env.email
set -euo pipefail

PROFILE="${1:?usage: populate-profile.sh <profile> <env-file>}"
ENVFILE="${2:?usage: populate-profile.sh <profile> <env-file>}"
: "${AWS_PROFILE:=sam-admin}"; export AWS_PROFILE
: "${AWS_REGION:=us-east-1}"; export AWS_REGION

HERE="$(cd "$(dirname "$0")" && pwd)"

BEARER=$(terraform -chdir="$HERE/terraform" output -json profile_bearers \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['$PROFILE'])")

BEARER="$BEARER" ENVFILE="$ENVFILE" python3 -c '
import json, os, re
env = {}
for line in open(os.environ["ENVFILE"]):
    m = re.match(r"^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$", line)
    if m:
        env[m.group(1)] = m.group(2)
print(json.dumps({
    "email":       env["MAIL_EMAIL"],
    "password":    env["MAIL_PASSWORD"],
    "fromName":    env.get("MAIL_FROM_NAME", ""),
    "fromAddress": env.get("MAIL_FROM_ADDRESS") or env["MAIL_EMAIL"],
    "imapHost":    env.get("MAIL_IMAP_HOST", "imap.zoho.com"),
    "smtpHost":    env.get("MAIL_SMTP_HOST", "smtp.zoho.com"),
    "dryRun":      env.get("MAIL_DRY_RUN", "true"),
    "bearer":      os.environ["BEARER"],
}))' | aws secretsmanager put-secret-value \
        --secret-id "email-mcp/$PROFILE" \
        --secret-string file:///dev/stdin \
        --query Name --output text >/dev/null

echo "✓ populated email-mcp/$PROFILE from $ENVFILE (password not shown)"
