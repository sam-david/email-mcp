# Deploying email-mcp (remote, multi-tenant)

Hosts the server as a remote **Streamable-HTTP MCP** so cloud / scheduled Claude
agents can reach it. Target: **AWS App Runner** (a persistent container — the
right fit for stateful MCP sessions) behind **`mcp.samdavid.email`** in Route53.

**Multi-tenant:** the URL path selects the mailbox. Each profile is one Secrets
Manager secret (`email-mcp/<profile>`) holding its creds *and* its bearer token.
Endpoint per profile: `https://mcp.samdavid.email/<profile>`.

**Auth:** each profile is its own OAuth 2.1 issuer, so a profile URL is both the
MCP resource and its authorization server:

| Path | Purpose |
|------|---------|
| `/<profile>` | the MCP endpoint (also `/<profile>/mcp`) |
| `/.well-known/oauth-protected-resource/<profile>` | RFC 9728 — what the 401 points at |
| `/.well-known/oauth-authorization-server/<profile>` | RFC 8414 |
| `/<profile>/register` | RFC 7591 dynamic client registration |
| `/<profile>/authorize` · `/<profile>/token` | PKCE (S256) authorization code flow |

Nothing is stored server-side: registrations, codes and tokens are HMAC blobs
signed with a key derived from that profile's bearer, so they survive restarts
and extra instances without a database.

> **Status: scaffold.** Validated, not yet applied end-to-end. Expect to iterate
> on the first `apply` (App Runner custom-domain + IAM specifics).

## Why App Runner (not Lambda)

MCP-over-HTTP is **stateful** (per-session transports). A long-running container
holds sessions in memory naturally; Lambda's per-request statelessness fights
that. App Runner runs the container as-is, terminates TLS, does custom domains,
and scales down cheaply.

## Prerequisites

- AWS account with the `samdavid.email` **Route53 hosted zone** in it.
- Docker + AWS CLI (`--profile sam-admin`) + Terraform.

## Deploy

```bash
cd deploy/terraform
cp terraform.tfvars.example terraform.tfvars   # adjust if needed
export AWS_PROFILE=sam-admin

# 1. Create ECR (+ secrets shells, IAM) first
terraform init
terraform apply -target=aws_ecr_repository.app

# 2. Build + push the image (repo root context)
REPO=$(terraform output -raw ecr_repository_url)
aws ecr get-login-password | docker login --username AWS --password-stdin "${REPO%/*}"
docker build -t "$REPO:latest" ../..
docker push "$REPO:latest"

# 3. Apply the rest (App Runner + custom domain + Route53 records)
terraform apply
```

## Populate a mailbox secret (the password never touches Terraform)

Grab the suggested bearer token, then write the profile's JSON:

```bash
BEARER=$(terraform output -json profile_bearers | jq -r '.dva')

aws secretsmanager put-secret-value --secret-id email-mcp/dva --secret-string "{
  \"email\":       \"hello@delawarevalleyaerial.com\",
  \"password\":    \"YOUR-APP-SPECIFIC-PASSWORD\",
  \"fromName\":    \"Sam David\",
  \"fromAddress\": \"sam@delawarevalleyaerial.com\",
  \"imapHost\":    \"imappro.zoho.com\",
  \"smtpHost\":    \"smtppro.zoho.com\",
  \"dryRun\":      \"false\",
  \"bearer\":      \"$BEARER\"
}"
```

## Register in Claude

The profile's bearer token is the one credential, but different Claude surfaces
present it differently.

### claude.ai / Claude Desktop — custom connector (OAuth)

The connector UI has no request-header field, so it needs the OAuth 2.1 flow
the server implements (see `src/oauth.mjs`). Just add the URL:

- **URL:** `https://mcp.samdavid.email/dva`

Claude discovers the endpoints, registers itself dynamically, and opens a
consent page. **Paste the profile's bearer token there** — that's the login.
Claude then holds a short-lived access token plus a refresh token; you won't be
asked again unless the bearer is rotated.

### Claude Code — static bearer

```bash
claude mcp add --transport http email https://mcp.samdavid.email/dva \
  --header "Authorization: Bearer <the dva bearer>"
```

### Messages API MCP connector

Pass the bearer as `authorization_token` on the server definition.

Then run `check_connection`, and confirm a **scheduled routine** can call it.

### Rotating / revoking

OAuth tokens are signed with a key derived from the profile's bearer, so
changing `bearer` in the secret invalidates every token ever issued for that
mailbox. Rotate the bearer to cut off access; re-add the connector to restore it.

## Add another mailbox — no redeploy

```bash
# generate a token, then create the secret; the running service picks it up
aws secretsmanager create-secret --name email-mcp/acme --secret-string '{...}'
```
Register a second Claude connector at `https://mcp.samdavid.email/acme` with
that profile's bearer. Same service, same domain, different path.
