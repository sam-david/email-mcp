# Alerting for scheduled sends.
#
# Every outage so far was found by a human noticing an email had not arrived.
# The dead-letter queue added in 6ec7994 preserves a failed send's payload, but
# a queue nobody watches is a quieter version of the same problem: the message
# sits there indefinitely and list_scheduled only reports it if someone asks.
#
# These alarms are the part that reaches out rather than waiting to be asked.

resource "aws_sns_topic" "alerts" {
  name = "${var.service_name}-alerts"
}

resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
  # NOTE: AWS sends a confirmation link to this address. Until it is clicked the
  # subscription is "PendingConfirmation" and NO alerts are delivered.
}

# A scheduled send that exhausted its retries. This is the one that matters:
# it means an email the user believes is queued will never go out.
resource "aws_cloudwatch_metric_alarm" "dlq_not_empty" {
  alarm_name          = "${var.service_name}-scheduled-send-failed"
  alarm_description   = "A scheduled email failed to send and is sitting in the dead-letter queue. It did NOT go out. Inspect with: aws sqs receive-message --queue-url ${aws_sqs_queue.scheduler_dlq.url} --max-number-of-messages 10"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.scheduler_dlq.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  # Missing data is normal for an empty queue; do not alarm on it.
  treat_missing_data = "notBreaching"
  alarm_actions      = [aws_sns_topic.alerts.arn]
  ok_actions         = [aws_sns_topic.alerts.arn]
}

# The worker erroring at all -- catches a failure before retries are exhausted,
# and catches causes the DLQ would not distinguish (bad creds, SMTP refusal).
resource "aws_cloudwatch_metric_alarm" "worker_errors" {
  alarm_name          = "${var.service_name}-send-worker-errors"
  alarm_description   = "The scheduled-send worker Lambda is throwing. Check /aws/lambda/${aws_lambda_function.worker.function_name}."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.worker.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# --- Daily canary ------------------------------------------------------------
# Alarms above only fire when something throws. Two of the three outages so far
# threw nothing: the send was queued against a profile that did not exist, or
# never queued at all. Nothing errored; mail simply stopped going out.
#
# So the canary exercises the real path on a schedule, and the alarm watches for
# the ABSENCE of a delivery rather than the presence of an error.
resource "aws_scheduler_schedule" "canary" {
  name                         = "emailmcp-canary-daily"
  group_name                   = aws_scheduler_schedule_group.email.name
  schedule_expression          = "rate(1 day)"
  schedule_expression_timezone = "UTC"
  flexible_time_window { mode = "OFF" }

  target {
    arn      = aws_lambda_function.worker.arn
    role_arn = aws_iam_role.scheduler.arn
    input = jsonencode({
      profile = "two-hens"
      to      = var.alert_email
      subject = "[email-mcp canary] scheduled sending is working"
      body    = "Automated daily check. Receiving this means EventBridge Scheduler fired, the worker loaded credentials from Secrets Manager, and Zoho accepted the message.\n\nIf these stop arriving, scheduled sending is broken — the CloudWatch alarm email-mcp-no-scheduled-deliveries covers that case.\n\nSafe to filter out of your inbox; the alarm is what matters."
    })
    retry_policy { maximum_retry_attempts = 2 }
    dead_letter_config { arn = aws_sqs_queue.scheduler_dlq.arn }
  }
}

# Turn the worker's success log line into a metric, so "nothing was delivered"
# becomes something that can be alarmed on.
resource "aws_cloudwatch_log_metric_filter" "deliveries" {
  name           = "${var.service_name}-scheduled-deliveries"
  log_group_name = "/aws/lambda/${aws_lambda_function.worker.function_name}"
  pattern        = "\"scheduled send delivered\""
  metric_transformation {
    name      = "ScheduledSendDelivered"
    namespace = "email-mcp"
    value     = "1"
    # Report 0 when nothing matched, otherwise the metric is simply absent and
    # the alarm below can never evaluate.
    default_value = "0"
  }
}

# The canary runs daily, so a 25-hour window with no delivery at all means the
# path is broken — whether or not anything threw.
resource "aws_cloudwatch_metric_alarm" "no_deliveries" {
  alarm_name          = "${var.service_name}-no-scheduled-deliveries"
  alarm_description   = "No scheduled email has been delivered in 25 hours, and the daily canary should have produced one. Scheduled sending is broken even though nothing errored. Check /aws/lambda/${aws_lambda_function.worker.function_name} and the EventBridge schedule group ${aws_scheduler_schedule_group.email.name}."
  namespace           = "email-mcp"
  metric_name         = "ScheduledSendDelivered"
  statistic           = "Sum"
  period              = 90000 # 25h
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching" # no data at all is exactly the failure
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# Let the MCP server read alarm state, so health_check can report it and a
# monitoring routine can act on something other than a human noticing.
data "aws_iam_policy_document" "server_cloudwatch_read" {
  statement {
    actions   = ["cloudwatch:DescribeAlarms", "cloudwatch:GetMetricStatistics"]
    resources = ["*"] # neither action supports resource-level permissions
  }
}

resource "aws_iam_role_policy" "server_cloudwatch_read" {
  name   = "cloudwatch-read"
  role   = aws_iam_role.instance.id
  policy = data.aws_iam_policy_document.server_cloudwatch_read.json
}
