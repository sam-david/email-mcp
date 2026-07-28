# Deploying email-mcp (remote, multi-tenant)

Hosts the server as a remote **Streamable-HTTP MCP** so cloud / scheduled Claude
agents can reach it. Target: **AWS App Runner** (a persistent container — the
right fit for stateful MCP sessions) behind **`mcp.samdavid.email`** in Route53.

**Multi-tenant:** the URL path selects the mailbox. Each profile is one Secrets
Manager secret (`email-mcp/<profile>`) holding its creds *and* its bearer token.
Endpoint per profile: `https://mcp.samdavid.email/<profile>`.

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

## Register in Claude (custom connector)

- **URL:** `https://mcp.samdavid.email/dva`
- **Request header:** `Authorization: Bearer <the dva bearer>`

Then run `check_connection`, and confirm a **scheduled routine** can call it.

## Add another mailbox — no redeploy

```bash
# generate a token, then create the secret; the running service picks it up
aws secretsmanager create-secret --name email-mcp/acme --secret-string '{...}'
```
Register a second Claude connector at `https://mcp.samdavid.email/acme` with
that profile's bearer. Same service, same domain, different path.
