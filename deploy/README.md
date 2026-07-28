# Deploying email-mcp (remote HTTP)

Hosts the server as a remote **Streamable-HTTP MCP** so cloud / scheduled Claude
agents can reach it. Target: **AWS App Runner** (a persistent container — the
right fit for stateful MCP sessions) behind **`mcp.samdavid.email`** in Route53.

> **Status: scaffold.** Reviewed but not yet applied. Expect to iterate on the
> first `apply` (App Runner custom-domain + IAM details).

## Why App Runner (not Lambda)

MCP-over-HTTP is **stateful** (per-session transports). A long-running container
holds sessions in memory naturally; Lambda's per-request statelessness fights
that. App Runner runs the container as-is, terminates TLS, does custom domains,
and scales down cheaply. Fargate/ECS would also work.

## One-time prerequisites

- An AWS account (ideally a **personal/tools** account, separate from any
  business account) with the `samdavid.email` **Route53 hosted zone** in it.
- Docker + AWS CLI + Terraform installed.

## Deploy

```bash
cd deploy/terraform
cp terraform.tfvars.example terraform.tfvars   # fill in (gitignored)
export TF_VAR_mail_password='your-app-specific-password'

# 1. Create the ECR repo (and secrets/roles) first
terraform init
terraform apply -target=aws_ecr_repository.app

# 2. Build + push the image
REPO=$(terraform output -raw ecr_repository_url)
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin "${REPO%/*}"
docker build -t "$REPO:latest" ../..
docker push "$REPO:latest"

# 3. Apply the rest (App Runner + custom domain + Route53)
terraform apply
```

## After apply

```bash
terraform output mcp_endpoint          # https://mcp.samdavid.email/mcp
terraform output -raw bearer_token     # the Authorization: Bearer value
```

Register in Claude as a **custom connector**:
- **URL:** the `mcp_endpoint`
- **Request header:** `Authorization: Bearer <bearer_token>`

Then verify `check_connection`, and that a **scheduled routine** can call it.

## Adding another mailbox

This scaffold deploys **one mailbox** (the `mail_*` vars → one App Runner
service + its own secrets). For a second inbox, either run this module again
with different vars (its own service + domain, e.g. `mcp2.samdavid.email`), or
extend the server to resolve a per-request profile from the URL path and store
one secret per profile. The server's config layer is already
profile-structured to make the latter a small change.
