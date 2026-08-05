#!/usr/bin/env bash
# Manage the named attachments that sends can reference by name.
#
#   ./deploy/asset.sh put pricing-sheet ~/Desktop/pricing-2026.pdf
#   ./deploy/asset.sh list
#   ./deploy/asset.sh get pricing-sheet ./downloaded.pdf
#   ./deploy/asset.sh rm  pricing-sheet
#
# Uploading here rather than through the MCP server is the point: the bytes go
# straight from this machine to S3, so a 4 MB PDF costs nothing and never has
# to be base64'd through a tool call. Afterwards any send — immediate,
# scheduled, or from a headless routine — attaches it with:
#
#   { "asset": "pricing-sheet" }
#
# Re-running `put` with the same name replaces it, and every later send picks up
# the new version.
set -euo pipefail

: "${AWS_PROFILE:=sam-admin}"
: "${AWS_REGION:=us-east-1}"
export AWS_PROFILE AWS_REGION

BUCKET="${ASSETS_BUCKET:-}"
if [ -z "$BUCKET" ]; then
  # Same expression Terraform uses: <service>-<account id>.
  ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
  BUCKET="email-mcp-${ACCOUNT}"
fi

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }
[ $# -ge 1 ] || usage

case "$1" in
  put)
    [ $# -eq 3 ] || usage
    NAME="$2"; FILE="$3"
    [ -f "$FILE" ] || { echo "no such file: $FILE" >&2; exit 1; }
    # The name is an S3 key segment and a tool argument; keep it a plain slug.
    echo "$NAME" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' \
      || { echo "invalid asset name '$NAME' — letters, digits, dot, dash, underscore (max 64)" >&2; exit 1; }
    TYPE=$(file --mime-type -b "$FILE" 2>/dev/null || echo application/octet-stream)
    aws s3api put-object \
      --bucket "$BUCKET" --key "assets/$NAME" \
      --body "$FILE" --content-type "$TYPE" \
      --metadata "filename=$(basename "$FILE")" >/dev/null
    printf 'saved "%s" — %s (%s, %s bytes)\n' \
      "$NAME" "$(basename "$FILE")" "$TYPE" "$(wc -c <"$FILE" | tr -d ' ')"
    echo "attach it with: { \"asset\": \"$NAME\" }"
    ;;
  list)
    aws s3api list-objects-v2 --bucket "$BUCKET" --prefix assets/ \
      --query 'Contents[].{name:Key,bytes:Size,updated:LastModified}' --output table 2>/dev/null \
      || echo "(no assets yet)"
    ;;
  get)
    [ $# -eq 3 ] || usage
    aws s3api get-object --bucket "$BUCKET" --key "assets/$2" "$3" >/dev/null
    echo "wrote $3"
    ;;
  rm)
    [ $# -eq 2 ] || usage
    aws s3api delete-object --bucket "$BUCKET" --key "assets/$2" >/dev/null
    echo "deleted \"$2\""
    ;;
  *) usage ;;
esac
