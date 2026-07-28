variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "service_name" {
  type    = string
  default = "email-mcp"
}

# Public hostname for the MCP endpoint (a subdomain — App Runner custom domains
# can't be an apex). Endpoint per profile: https://<domain_name>/<profile>
variable "domain_name" {
  type    = string
  default = "mcp.samdavid.email"
}

# The Route53 hosted zone the domain lives in.
variable "route53_zone_name" {
  type    = string
  default = "samdavid.email"
}

variable "image_tag" {
  type    = string
  default = "latest"
}

# Mailbox profiles to pre-create secret shells for. You can also add profiles
# purely via the CLI later (the service reads any email-mcp/* secret) — no
# redeploy needed. Each profile's JSON value is populated out-of-band.
variable "profiles" {
  type    = list(string)
  default = ["dva"]
}
