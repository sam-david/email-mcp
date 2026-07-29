# Scheduled send: a worker Lambda invoked by EventBridge Scheduler at send time.
# Run `npm install --omit=dev` in lambda/worker before applying (packaged below).

data "archive_file" "worker" {
  type        = "zip"
  source_dir  = "${path.module}/../../lambda/worker"
  output_path = "${path.module}/build/worker.zip"
}

# --- Worker Lambda execution role: logs + read any email-mcp/* secret ---
data "aws_iam_policy_document" "worker_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "worker" {
  name               = "${var.service_name}-worker"
  assume_role_policy = data.aws_iam_policy_document.worker_assume.json
}

resource "aws_iam_role_policy_attachment" "worker_logs" {
  role       = aws_iam_role.worker.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "worker_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.me.account_id}:secret:${var.service_name}/*"]
  }
}

resource "aws_iam_role_policy" "worker_secrets" {
  name   = "read-secrets"
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.worker_secrets.json
}

resource "aws_lambda_function" "worker" {
  function_name    = "${var.service_name}-send-worker"
  role             = aws_iam_role.worker.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.worker.output_path
  source_code_hash = data.archive_file.worker.output_base64sha256
  timeout          = 30
  memory_size      = 256
  environment {
    variables = { SECRETS_PREFIX = "${var.service_name}/" }
  }
}

# --- EventBridge Scheduler group + a role Scheduler assumes to invoke the worker ---
resource "aws_scheduler_schedule_group" "email" {
  name = var.service_name
}

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${var.service_name}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

data "aws_iam_policy_document" "scheduler_invoke" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.worker.arn]
  }
}

resource "aws_iam_role_policy" "scheduler_invoke" {
  name   = "invoke-worker"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler_invoke.json
}

# --- Let the App Runner instance role create/manage schedules + pass the scheduler role ---
data "aws_iam_policy_document" "instance_scheduler" {
  statement {
    actions = [
      "scheduler:CreateSchedule",
      "scheduler:DeleteSchedule",
      "scheduler:GetSchedule",
      "scheduler:UpdateSchedule",
    ]
    resources = ["arn:aws:scheduler:${var.aws_region}:${data.aws_caller_identity.me.account_id}:schedule/${var.service_name}/*"]
  }
  statement {
    actions   = ["scheduler:ListSchedules"]
    resources = ["*"]
  }
  statement {
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.scheduler.arn]
  }
}

resource "aws_iam_role_policy" "instance_scheduler" {
  name   = "scheduler"
  role   = aws_iam_role.instance.id
  policy = data.aws_iam_policy_document.instance_scheduler.json
}
