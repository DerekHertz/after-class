# Emails the operator when the data volume runs low, before the app's ingest floor (2 GiB free) starts refusing uploads.
# The app logs one JSON line about the volume at start and every 15 minutes (src/backend/evidence/disk-watch.ts). A metric
# filter turns its freeMib into a metric and an alarm watches the smallest reading. It adds no agent and no instance
# change, so applying it never replaces the instance. Off until alarm_email is set.
locals {
  disk_alarm = var.alarm_email != null
}

resource "aws_cloudwatch_log_metric_filter" "disk_free" {
  count = local.disk_alarm ? 1 : 0

  name           = "${var.name}-disk-free-mib"
  log_group_name = aws_cloudwatch_log_group.beta.name
  pattern        = "{ $.event = \"disk\" }"

  metric_transformation {
    name      = "DataVolumeFreeMiB"
    namespace = "AfterClass/${var.name}"
    value     = "$.freeMib"
    unit      = "Megabytes"
  }
}

# No customer content is published, so the topic uses no key. CloudWatch cannot publish to a topic that uses the aws/sns key.
resource "aws_sns_topic" "alerts" {
  count = local.disk_alarm ? 1 : 0

  name = "${var.name}-alerts"
}

# The address gets a confirmation email once. Nothing is sent until the link in it is opened.
resource "aws_sns_topic_subscription" "alerts_email" {
  count = local.disk_alarm ? 1 : 0

  topic_arn = aws_sns_topic.alerts[0].arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

# A gap in readings is not a breach: a deploy restarts the app and a few quarter hours may log nothing. A stopped app shows
# in the deploy script and the health check, not here.
resource "aws_cloudwatch_metric_alarm" "disk_free" {
  count = local.disk_alarm ? 1 : 0

  alarm_name          = "${var.name}-data-volume-low"
  alarm_description   = "Free space on /data fell under ${var.disk_alarm_free_mib} MiB. The app refuses uploads under 2048 MiB. Free space or enlarge the volume."
  namespace           = "AfterClass/${var.name}"
  metric_name         = "DataVolumeFreeMiB"
  statistic           = "Minimum"
  period              = 900
  evaluation_periods  = 1
  comparison_operator = "LessThanThreshold"
  threshold           = var.disk_alarm_free_mib
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts[0].arn]

  depends_on = [aws_cloudwatch_log_metric_filter.disk_free]
}
