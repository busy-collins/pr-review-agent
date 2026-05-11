import * as cdk        from 'aws-cdk-lib';
import * as cloudwatch  from 'aws-cdk-lib/aws-cloudwatch';
import * as actions     from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns         from 'aws-cdk-lib/aws-sns';
import * as lambda      from 'aws-cdk-lib/aws-lambda';
import * as sfn         from 'aws-cdk-lib/aws-stepfunctions';
import * as dynamodb    from 'aws-cdk-lib/aws-dynamodb';
import { Construct }    from 'constructs';

interface CloudWatchStackProps extends cdk.StackProps {
  appEnv:         string;
  tags:           Record<string, string>;
  orchestratorFn: lambda.Function;
  securityFn:     lambda.Function;
  styleFn:        lambda.Function;
  aggregatorFn:   lambda.Function;
  stateMachine:   sfn.StateMachine;
  sessionTable:   dynamodb.Table;
}

// ============================================================
// CloudWatch Stack
// Dashboards, alarms, and SNS alerts for the full pipeline
// ============================================================
export class CloudWatchStack extends cdk.Stack {

  public readonly alertTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: CloudWatchStackProps) {
    super(scope, id, props);

    // --------------------------------------------------------
    // SNS Topic — receives all critical alarms
    // --------------------------------------------------------
    this.alertTopic = new sns.Topic(this, 'AlertTopic', {
      topicName:   `pr-review-alerts-${props.appEnv}`,
      displayName: 'PR Review Agent Critical Alerts',
    });

    // --------------------------------------------------------
    // Key Metrics
    // --------------------------------------------------------

    // Pipeline execution failures
    const pipelineFailures = new cloudwatch.Metric({
      namespace:  'AWS/States',
      metricName: 'ExecutionsFailed',
      dimensionsMap: { StateMachineArn: props.stateMachine.stateMachineArn },
      statistic:  'Sum',
      period:     cdk.Duration.minutes(5),
    });

    // Pipeline execution duration
    const pipelineDuration = new cloudwatch.Metric({
      namespace:  'AWS/States',
      metricName: 'ExecutionTime',
      dimensionsMap: { StateMachineArn: props.stateMachine.stateMachineArn },
      statistic:  'p95',
      period:     cdk.Duration.minutes(5),
      label:      'Pipeline Duration p95',
    });

    // Lambda error rates
    const orchestratorErrors = props.orchestratorFn.metricErrors({ period: cdk.Duration.minutes(5) });
    const securityErrors      = props.securityFn.metricErrors({ period: cdk.Duration.minutes(5) });
    const styleErrors         = props.styleFn.metricErrors({ period: cdk.Duration.minutes(5) });
    const aggregatorErrors    = props.aggregatorFn.metricErrors({ period: cdk.Duration.minutes(5) });

    // Lambda durations
    const securityDuration  = props.securityFn.metricDuration({ statistic: 'p95', period: cdk.Duration.minutes(5) });
    const styleDuration     = props.styleFn.metricDuration({ statistic: 'p95', period: cdk.Duration.minutes(5) });
    const aggregatorDuration = props.aggregatorFn.metricDuration({ statistic: 'p95', period: cdk.Duration.minutes(5) });

    // Lambda throttles
    const securityThrottles  = props.securityFn.metricThrottles({ period: cdk.Duration.minutes(5) });
    const styleThrottles     = props.styleFn.metricThrottles({ period: cdk.Duration.minutes(5) });

    // Custom metrics from agents
    const escalationCount = new cloudwatch.Metric({
      namespace:  'PRReviewAgent',
      metricName: 'EscalationCount',
      statistic:  'Sum',
      period:     cdk.Duration.hours(1),
    });

    const confidenceScore = new cloudwatch.Metric({
      namespace:  'PRReviewAgent',
      metricName: 'OverallConfidenceScore',
      statistic:  'Average',
      period:     cdk.Duration.hours(1),
    });

    const reviewsCompleted = new cloudwatch.Metric({
      namespace:  'PRReviewAgent',
      metricName: 'ReviewsCompleted',
      statistic:  'Sum',
      period:     cdk.Duration.hours(1),
    });

    const checkpointFailures = new cloudwatch.Metric({
      namespace:  'PRReviewAgent',
      metricName: 'CheckpointFailed',
      statistic:  'Sum',
      period:     cdk.Duration.minutes(5),
    });

    // --------------------------------------------------------
    // Alarms
    // --------------------------------------------------------

    // CRITICAL: Pipeline failure rate > 5 in 5 minutes
    const pipelineFailureAlarm = new cloudwatch.Alarm(this, 'PipelineFailureAlarm', {
      alarmName:          `pr-review-pipeline-failures-${props.appEnv}`,
      alarmDescription:   'More than 5 pipeline failures in 5 minutes',
      metric:             pipelineFailures,
      threshold:          5,
      evaluationPeriods:  1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData:   cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    pipelineFailureAlarm.addAlarmAction(new actions.SnsAction(this.alertTopic));

    // CRITICAL: Pipeline p95 duration > 5 minutes
    const pipelineDurationAlarm = new cloudwatch.Alarm(this, 'PipelineDurationAlarm', {
      alarmName:          `pr-review-pipeline-duration-${props.appEnv}`,
      alarmDescription:   'Pipeline p95 duration exceeds 5 minutes',
      metric:             pipelineDuration,
      threshold:          300000, // 5 minutes in milliseconds
      evaluationPeriods:  2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData:   cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    pipelineDurationAlarm.addAlarmAction(new actions.SnsAction(this.alertTopic));

    // WARNING: Security agent errors
    const securityErrorAlarm = new cloudwatch.Alarm(this, 'SecurityAgentErrorAlarm', {
      alarmName:          `pr-review-security-errors-${props.appEnv}`,
      alarmDescription:   'Security SubAgent Lambda errors detected',
      metric:             securityErrors,
      threshold:          3,
      evaluationPeriods:  1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData:   cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    securityErrorAlarm.addAlarmAction(new actions.SnsAction(this.alertTopic));

    // WARNING: Checkpoint failures
    new cloudwatch.Alarm(this, 'CheckpointFailureAlarm', {
      alarmName:          `pr-review-checkpoint-failures-${props.appEnv}`,
      alarmDescription:   'DynamoDB checkpoint writes are failing',
      metric:             checkpointFailures,
      threshold:          1,
      evaluationPeriods:  1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData:   cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new actions.SnsAction(this.alertTopic));

    // --------------------------------------------------------
    // CloudWatch Dashboard
    // --------------------------------------------------------
    const dashboard = new cloudwatch.Dashboard(this, 'PRReviewDashboard', {
      dashboardName: `PRReviewAgent-${props.appEnv}`,
      periodOverride: cloudwatch.PeriodOverride.AUTO,
    });

    // Row 1 — Pipeline overview
    dashboard.addWidgets(
      new cloudwatch.SingleValueWidget({
        title:   'Reviews Completed (1hr)',
        metrics: [reviewsCompleted],
        width:   4, height: 3,
      }),
      new cloudwatch.SingleValueWidget({
        title:   'Escalations (1hr)',
        metrics: [escalationCount],
        width:   4, height: 3,
      }),
      new cloudwatch.SingleValueWidget({
        title:   'Avg Confidence Score (1hr)',
        metrics: [confidenceScore],
        width:   4, height: 3,
      }),
      new cloudwatch.AlarmStatusWidget({
        title:  'Alarm Status',
        alarms: [pipelineFailureAlarm, pipelineDurationAlarm, securityErrorAlarm],
        width:  12, height: 3,
      }),
    );

    // Row 2 — Pipeline execution metrics
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title:  'Pipeline Executions',
        left:   [reviewsCompleted, pipelineFailures],
        width:  12, height: 6,
      }),
      new cloudwatch.GraphWidget({
        title:  'Pipeline Duration p95',
        left:   [pipelineDuration],
        width:  12, height: 6,
      }),
    );

    // Row 3 — SubAgent performance
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title:  'SubAgent Duration p95',
        left:   [securityDuration, styleDuration, aggregatorDuration],
        width:  12, height: 6,
      }),
      new cloudwatch.GraphWidget({
        title:  'SubAgent Errors & Throttles',
        left:   [securityErrors, styleErrors, aggregatorErrors],
        right:  [securityThrottles, styleThrottles],
        width:  12, height: 6,
      }),
    );

    // Row 4 — Reliability
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title:  'Escalations Over Time',
        left:   [escalationCount],
        width:  12, height: 6,
      }),
      new cloudwatch.GraphWidget({
        title:  'Checkpoint Failures',
        left:   [checkpointFailures, orchestratorErrors],
        width:  12, height: 6,
      }),
    );

    // Row 5 — Lambda errors detail
    dashboard.addWidgets(
      new cloudwatch.LogQueryWidget({
        title:     'Recent Pipeline Errors',
        logGroupNames: [
          `/aws/lambda/pr-review-orchestrator-${props.appEnv}`,
          `/aws/lambda/pr-review-security-agent-${props.appEnv}`,
          `/aws/lambda/pr-review-style-agent-${props.appEnv}`,
          `/aws/lambda/pr-review-aggregator-${props.appEnv}`,
        ],
        queryLines: [
          'fields @timestamp, level, service, message, sessionId',
          'filter level = "ERROR"',
          'sort @timestamp desc',
          'limit 20',
        ],
        width: 24, height: 8,
      }),
    );

    // --------------------------------------------------------
    // CloudFormation Outputs
    // --------------------------------------------------------
    new cdk.CfnOutput(this, 'DashboardURL', {
      value:      `https://${this.region}.console.aws.amazon.com/cloudwatch/home#dashboards:name=PRReviewAgent-${props.appEnv}`,
      exportName: `PRReviewDashboardURL-${props.appEnv}`,
    });

    new cdk.CfnOutput(this, 'AlertTopicArn', {
      value:      this.alertTopic.topicArn,
      exportName: `PRReviewAlertTopicArn-${props.appEnv}`,
    });
  }
}