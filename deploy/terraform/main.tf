# email-mcp — remote hosting on AWS App Runner (a persistent container fits the
# stateful Streamable-HTTP MCP protocol), fronted by a custom domain in Route53.
#
# Multi-tenant: the URL path selects the mailbox profile; each profile's creds +
# bearer token live in its own Secrets Manager secret (email-mcp/<profile>).
# Endpoint per profile: https://<domain>/<profile>
#
# SCAFFOLD: validated; expect to iterate on the first apply (App Runner custom
# domain + IAM). Build+push the image before applying — see deploy/README.md.

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 5.0" }
    random  = { source = "hashicorp/random", version = "~> 3.5" }
    archive = { source = "hashicorp/archive", version = "~> 2.4" }
  }
}

provider "aws" {
  region = var.aws_region
}

data "aws_caller_identity" "me" {}

# ---------------------------------------------------------------- ECR
resource "aws_ecr_repository" "app" {
  name                 = var.service_name
  image_tag_mutability = "MUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
}

# ---------------------------------------------------------------- Secrets
# One shell secret per profile. Populate the JSON value OUT OF BAND (see
# deploy/README.md) so the mailbox password never lands in Terraform state.
# New profiles can also be created directly with the CLI later — no redeploy,
# since the instance role can read any email-mcp/* secret.
resource "aws_secretsmanager_secret" "profile" {
  for_each = toset(var.profiles)
  name     = "${var.service_name}/${each.key}"
}

# A suggested bearer token per profile — use it when you populate the secret.
resource "random_password" "bearer" {
  for_each = toset(var.profiles)
  length   = 48
  special  = false
}

# ---------------------------------------------------------------- IAM
data "aws_iam_policy_document" "apprunner_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["build.apprunner.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "apprunner_access" {
  name               = "${var.service_name}-apprunner-access"
  assume_role_policy = data.aws_iam_policy_document.apprunner_assume.json
}

resource "aws_iam_role_policy_attachment" "ecr_access" {
  role       = aws_iam_role.apprunner_access.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess"
}

data "aws_iam_policy_document" "instance_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["tasks.apprunner.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "instance" {
  name               = "${var.service_name}-instance"
  assume_role_policy = data.aws_iam_policy_document.instance_assume.json
}

# Read any email-mcp/* secret, so adding a profile needs no IAM change.
data "aws_iam_policy_document" "read_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.me.account_id}:secret:${var.service_name}/*"]
  }
}

resource "aws_iam_role_policy" "read_secrets" {
  name   = "read-secrets"
  role   = aws_iam_role.instance.id
  policy = data.aws_iam_policy_document.read_secrets.json
}

# ---------------------------------------------------------------- App Runner
# MCP-over-HTTP sessions live in the container's memory and App Runner has no
# session affinity, so a second instance would answer with "unknown session id"
# for a session opened on the first. Pin to exactly one instance: this is a
# single-mailbox tool that will never need to scale out, and the failure mode is
# confusing (auth succeeds, sessions break at random).
resource "aws_apprunner_auto_scaling_configuration_version" "app" {
  auto_scaling_configuration_name = var.service_name
  max_concurrency                 = 100
  min_size                        = 1
  max_size                        = 1
}

resource "aws_apprunner_service" "app" {
  service_name                   = var.service_name
  auto_scaling_configuration_arn = aws_apprunner_auto_scaling_configuration_version.app.arn

  # Ensure the access role can actually pull from ECR (and the instance role can
  # read secrets) BEFORE the service tries to deploy.
  depends_on = [
    aws_iam_role_policy_attachment.ecr_access,
    aws_iam_role_policy.read_secrets,
  ]

  source_configuration {
    auto_deployments_enabled = true
    authentication_configuration {
      access_role_arn = aws_iam_role.apprunner_access.arn
    }
    image_repository {
      image_identifier      = "${aws_ecr_repository.app.repository_url}:${var.image_tag}"
      image_repository_type = "ECR"
      image_configuration {
        port = "8080"
        runtime_environment_variables = {
          SECRETS_PREFIX     = "${var.service_name}/"
          AWS_REGION         = var.aws_region
          WORKER_LAMBDA_ARN  = aws_lambda_function.worker.arn
          SCHEDULER_ROLE_ARN = aws_iam_role.scheduler.arn
          SCHEDULER_GROUP    = aws_scheduler_schedule_group.email.name
          # OAuth metadata advertises absolute URLs; pin them to the custom
          # domain rather than inferring the scheme/host from proxy headers.
          PUBLIC_BASE_URL = "https://${var.domain_name}"
        }
      }
    }
  }

  instance_configuration {
    cpu               = "256" # 0.25 vCPU
    memory            = "512" # 0.5 GB
    instance_role_arn = aws_iam_role.instance.arn
  }

  health_check_configuration {
    protocol            = "TCP"
    interval            = 10
    timeout             = 5
    healthy_threshold   = 1
    unhealthy_threshold = 5
  }
}

# ---------------------------------------------------------------- Domain (Route53)
data "aws_route53_zone" "root" {
  name = var.route53_zone_name
}

resource "aws_apprunner_custom_domain_association" "app" {
  domain_name = var.domain_name
  service_arn = aws_apprunner_service.app.arn
}

# Cert validation CNAMEs returned by App Runner.
resource "aws_route53_record" "cert_validation" {
  for_each = {
    for r in aws_apprunner_custom_domain_association.app.certificate_validation_records : r.name => r
  }
  zone_id = data.aws_route53_zone.root.zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.value]
  ttl     = 300
}

# Point the domain at the App Runner service.
resource "aws_route53_record" "app" {
  zone_id = data.aws_route53_zone.root.zone_id
  name    = var.domain_name
  type    = "CNAME"
  records = [aws_apprunner_custom_domain_association.app.dns_target]
  ttl     = 300
}
