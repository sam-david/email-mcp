variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "service_name" {
  type    = string
  default = "email-mcp"
}

# Public hostname for the MCP endpoint (a subdomain — App Runner custom domains
# can't be an apex). e.g. mcp.samdavid.email
variable "domain_name" {
  type    = string
  default = "mcp.samdavid.email"
}

# The Route53 hosted zone the domain lives in. e.g. samdavid.email
variable "route53_zone_name" {
  type    = string
  default = "samdavid.email"
}

variable "image_tag" {
  type    = string
  default = "latest"
}

# --- Mailbox config (non-secret) ---
variable "mail_email" {
  type        = string
  description = "IMAP/SMTP login address (e.g. hello@delawarevalleyaerial.com)."
}

variable "mail_from_name" {
  type    = string
  default = ""
}

variable "mail_from_address" {
  type        = string
  description = "Verified alias to send as (e.g. sam@…). Defaults to mail_email if empty."
  default     = ""
}

variable "imap_host" {
  type    = string
  default = "imappro.zoho.com"
}

variable "smtp_host" {
  type    = string
  default = "smtppro.zoho.com"
}

variable "dry_run" {
  type    = string
  default = "true"
}

# --- Secret (set via a gitignored *.tfvars, NEVER committed) ---
variable "mail_password" {
  type        = string
  sensitive   = true
  description = "App-specific password for the mailbox. Provide via a local tfvars or TF_VAR_mail_password."
}
