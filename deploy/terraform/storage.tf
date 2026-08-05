# Attachment storage. One private bucket, two prefixes with different lifetimes:
#
#   assets/   durable, named files reused across sends (a pricing sheet). These
#             are the point of the bucket — upload once, attach by name forever,
#             so the bytes never travel through an MCP tool call.
#   pending/  bytes for one scheduled send, waiting for the worker to fire.
#             EventBridge Scheduler caps its payload at 256 KB, so anything
#             document-sized has to wait here rather than in the event itself.
#
# The worker deletes a pending/ prefix once it has delivered; the lifecycle rule
# below is the backstop for schedules that were cancelled or never fired. It
# deliberately does NOT touch assets/, which must persist indefinitely.

resource "aws_s3_bucket" "attachments" {
  bucket = "${var.service_name}-${data.aws_caller_identity.me.account_id}"
}

resource "aws_s3_bucket_public_access_block" "attachments" {
  bucket                  = aws_s3_bucket.attachments.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "attachments" {
  bucket = aws_s3_bucket.attachments.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Keep a short history of an asset so a bad overwrite of the pricing sheet is
# recoverable — these are files sent to customers.
resource "aws_s3_bucket_versioning" "attachments" {
  bucket = aws_s3_bucket.attachments.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "attachments" {
  bucket     = aws_s3_bucket.attachments.id
  depends_on = [aws_s3_bucket_versioning.attachments]

  # Ephemeral spool only.
  rule {
    id     = "expire-pending"
    status = "Enabled"
    filter {
      prefix = "pending/"
    }
    expiration {
      days = 30
    }
    noncurrent_version_expiration {
      noncurrent_days = 1
    }
  }

  # Assets themselves never expire; only superseded versions age out.
  rule {
    id     = "trim-old-asset-versions"
    status = "Enabled"
    filter {
      prefix = "assets/"
    }
    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# --- Access: the MCP server reads and writes both prefixes; the worker only
# --- reads what it was pointed at and cleans up its own spool.
data "aws_iam_policy_document" "server_attachments" {
  statement {
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.attachments.arn}/assets/*", "${aws_s3_bucket.attachments.arn}/pending/*"]
  }
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.attachments.arn]
  }
}

resource "aws_iam_role_policy" "server_attachments" {
  name   = "attachments"
  role   = aws_iam_role.instance.id
  policy = data.aws_iam_policy_document.server_attachments.json
}

data "aws_iam_policy_document" "worker_attachments" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.attachments.arn}/assets/*", "${aws_s3_bucket.attachments.arn}/pending/*"]
  }
  # Cleanup after delivery is scoped to the spool; the worker can never delete
  # an asset.
  statement {
    actions   = ["s3:DeleteObject"]
    resources = ["${aws_s3_bucket.attachments.arn}/pending/*"]
  }
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.attachments.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["pending/*"]
    }
  }
}

resource "aws_iam_role_policy" "worker_attachments" {
  name   = "attachments"
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.worker_attachments.json
}
