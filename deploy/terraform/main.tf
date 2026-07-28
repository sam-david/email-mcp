# email-mcp — remote hosting on AWS App Runner (persistent container fits the
# stateful Streamable-HTTP MCP protocol), fronted by a custom domain in Route53.
#
# SCAFFOLD: not yet applied end-to-end. Review before `terraform apply`.
# Flow: build+push image to ECR (see deploy/README.md) → apply.

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.0" }
    random = { source = "hashicorp/random", version = "~> 3.5" }
  }
  # Consider an S3 backend for shared state; local state by default.
}

provider "aws" {
  region = var.aws_region
}

locals {
  from_address = var.mail_from_address != "" ? var.mail_from_address : var.mail_email
}

# ---------------------------------------------------------------------------
# Container registry
# ---------------------------------------------------------------------------
resource "aws_ecr_repository" "app" {
  name                 = var.service_name
  image_tag_mutability = "MUTABLE"
  image_scanning_configuration { scan_on_push = true }
}

# ---------------------------------------------------------------------------
# Secrets — mailbox password + a generated bearer token for the MCP endpoint
# ---------------------------------------------------------------------------
resource "aws_secretsmanager_secret" "mail_password" {
  name = "${var.service_name}/mail_password"
}
resource "aws_secretsmanager_secret_version" "mail_password" {
  secret_id     = aws_secretsmanager_secret.mail_password.id
  secret_string = var.mail_password
}

resource "random_password" "bearer" {
  length  = 48
  special = false
}
resource "aws_secretsmanager_secret" "bearer" {
  name = "${var.service_name}/bearer_token"
}
resource "aws_secretsmanager_secret_version" "bearer" {
  secret_id     = aws_secretsmanager_secret.bearer.id
  secret_string = random_password.bearer.result
}

# ---------------------------------------------------------------------------
# IAM — App Runner ECR access role + instance role (reads the two secrets)
# ---------------------------------------------------------------------------
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
data "aws_iam_policy_document" "read_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.mail_password.arn, aws_secretsmanager_secret.bearer.arn]
  }
}
resource "aws_iam_role_policy" "read_secrets" {
  name   = "read-secrets"
  role   = aws_iam_role.instance.id
  policy = data.aws_iam_policy_document.read_secrets.json
}

# ---------------------------------------------------------------------------
# App Runner service
# ---------------------------------------------------------------------------
resource "aws_apprunner_service" "app" {
  service_name = var.service_name

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
          MAIL_EMAIL        = var.mail_email
          MAIL_FROM_NAME    = var.mail_from_name
          MAIL_FROM_ADDRESS = local.from_address
          MAIL_IMAP_HOST    = var.imap_host
          MAIL_SMTP_HOST    = var.smtp_host
          MAIL_DRY_RUN      = var.dry_run
        }
        runtime_environment_secrets = {
          MAIL_PASSWORD    = aws_secretsmanager_secret.mail_password.arn
          MCP_BEARER_TOKEN = aws_secretsmanager_secret.bearer.arn
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
    protocol = "HTTP"
    path     = "/health"
  }
}

# ---------------------------------------------------------------------------
# Custom domain in Route53 (App Runner manages the TLS cert; we add the
# validation records + the CNAME to the App Runner target).
# ---------------------------------------------------------------------------
data "aws_route53_zone" "root" {
  name = var.route53_zone_name
}

resource "aws_apprunner_custom_domain_association" "app" {
  domain_name = var.domain_name
  service_arn = aws_apprunner_service.app.arn
}

# Certificate validation records (App Runner returns a set of CNAMEs to add).
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
