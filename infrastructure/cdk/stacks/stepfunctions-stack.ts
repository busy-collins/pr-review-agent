import * as cdk           from 'aws-cdk-lib';
import * as sfn           from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks         from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as lambda        from 'aws-cdk-lib/aws-lambda';
import * as logs          from 'aws-cdk-lib/aws-logs';
import { Construct }      from 'constructs';

interface StepFunctionsStackProps extends cdk.StackProps {
  appEnv:         string;
  tags:           Record<string, string>;
  orchestratorFn: lambda.Function;
  securityFn:     lambda.Function;
  styleFn:        lambda.Function;
  aggregatorFn:   lambda.Function;
}

// ============================================================
// Step Functions Stack
// Builds the full pipeline state machine in CDK using
// the typed StepFunctions constructs instead of raw ASL JSON
// ============================================================
export class StepFunctionsStack extends cdk.Stack {

  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: StepFunctionsStackProps) {
    super(scope, id, props);

    // --------------------------------------------------------
    // Terminal States
    // --------------------------------------------------------
    const reviewComplete = new sfn.Succeed(this, 'ReviewComplete');
    const reviewFailed   = new sfn.Fail(this, 'ReviewFailed', {
      error: 'ReviewPipelineFailed',
      cause: 'One or more stages failed after retries',
    });

    // --------------------------------------------------------
    // Failure Handlers — must precede the tasks that catch into them
    // --------------------------------------------------------
    const handleOrchestrationFailure = new tasks.LambdaInvoke(this, 'HandleOrchestrationFailure', {
      lambdaFunction: props.orchestratorFn,
      payload: sfn.TaskInput.fromObject({ action: 'HANDLE_FAILURE', stage: 'ORCHESTRATOR', error: sfn.JsonPath.stringAt('$.error') }),
    }).next(reviewFailed);

    const handleSubAgentFailure = new tasks.LambdaInvoke(this, 'HandleSubAgentFailure', {
      lambdaFunction: props.orchestratorFn,
      payload: sfn.TaskInput.fromObject({ action: 'HANDLE_FAILURE', stage: 'SUBAGENT', error: sfn.JsonPath.stringAt('$.error') }),
    }).next(reviewFailed);

    const handleAggregatorFailure = new tasks.LambdaInvoke(this, 'HandleAggregatorFailure', {
      lambdaFunction: props.orchestratorFn,
      payload: sfn.TaskInput.fromObject({ action: 'HANDLE_FAILURE', stage: 'AGGREGATOR', error: sfn.JsonPath.stringAt('$.error') }),
    }).next(reviewFailed);

    // --------------------------------------------------------
    // Step 1 — Validate PR Eligibility (Orchestrator Lambda)
    // --------------------------------------------------------
    const validateEligibility = new tasks.LambdaInvoke(this, 'ValidatePREligibility', {
      lambdaFunction:  props.orchestratorFn,
      payload:         sfn.TaskInput.fromObject({
        action:  'VALIDATE',
        payload: sfn.JsonPath.entirePayload,
      }),
      resultPath:      '$.orchestrator_result',
      retryOnServiceExceptions: true,
    }).addRetry({
      errors:       ['Lambda.ServiceException', 'Lambda.AWSLambdaException'],
      interval:     cdk.Duration.seconds(2),
      maxAttempts:  3,
      backoffRate:  2,
    }).addCatch(handleOrchestrationFailure, { resultPath: '$.error' });

    // --------------------------------------------------------
    // Post Size Warning (skipped PRs)
    // --------------------------------------------------------
    const postSizeWarning = new tasks.LambdaInvoke(this, 'PostSizeWarning', {
      lambdaFunction: props.orchestratorFn,
      payload: sfn.TaskInput.fromObject({
        action:      'POST_SIZE_WARNING',
        session_id:  sfn.JsonPath.stringAt('$.orchestrator_result.Payload.session_id'),
        pr_metadata: sfn.JsonPath.objectAt('$.orchestrator_result.Payload.pr_metadata'),
      }),
    }).next(reviewComplete);

    // --------------------------------------------------------
    // Slack Escalation Notification
    // --------------------------------------------------------
    const notifySlack = new tasks.LambdaInvoke(this, 'NotifySlackEscalation', {
      lambdaFunction: props.orchestratorFn,
      payload: sfn.TaskInput.fromObject({
        action:      'NOTIFY_SLACK',
        session_id:  sfn.JsonPath.stringAt('$.orchestrator_result.Payload.session_id'),
        pr_metadata: sfn.JsonPath.objectAt('$.orchestrator_result.Payload.pr_metadata'),
      }),
    }).next(reviewComplete);

    // --------------------------------------------------------
    // Security SubAgent — Ralph Loop (3 iterations)
    // --------------------------------------------------------
    const securityIter1 = new tasks.LambdaInvoke(this, 'SecurityAgentIteration1', {
      lambdaFunction: props.securityFn,
      payload: sfn.TaskInput.fromObject({
        session_id:        sfn.JsonPath.stringAt('$.orchestrator_result.Payload.session_id'),
        pr_metadata:       sfn.JsonPath.objectAt('$.orchestrator_result.Payload.pr_metadata'),
        diff_content:      sfn.JsonPath.stringAt('$.orchestrator_result.Payload.diff_content'),
        iteration:         1,
        previous_findings: null,
      }),
      resultPath: '$.security_iteration_1',
    }).addRetry({ errors: ['Lambda.ServiceException'], maxAttempts: 2, interval: cdk.Duration.seconds(2), backoffRate: 2 });

    const securityIter2 = new tasks.LambdaInvoke(this, 'SecurityAgentIteration2', {
      lambdaFunction: props.securityFn,
      payload: sfn.TaskInput.fromObject({
        session_id:        sfn.JsonPath.stringAt('$.orchestrator_result.Payload.session_id'),
        pr_metadata:       sfn.JsonPath.objectAt('$.orchestrator_result.Payload.pr_metadata'),
        diff_content:      sfn.JsonPath.stringAt('$.orchestrator_result.Payload.diff_content'),
        iteration:         2,
        previous_findings: sfn.JsonPath.objectAt('$.security_iteration_1.Payload.findings'),
      }),
      resultPath: '$.security_iteration_2',
    });

    const securityIter3 = new tasks.LambdaInvoke(this, 'SecurityAgentIteration3', {
      lambdaFunction: props.securityFn,
      payload: sfn.TaskInput.fromObject({
        session_id:        sfn.JsonPath.stringAt('$.orchestrator_result.Payload.session_id'),
        pr_metadata:       sfn.JsonPath.objectAt('$.orchestrator_result.Payload.pr_metadata'),
        diff_content:      sfn.JsonPath.stringAt('$.orchestrator_result.Payload.diff_content'),
        iteration:         3,
        previous_findings: sfn.JsonPath.objectAt('$.security_iteration_2.Payload.findings'),
      }),
      resultPath: '$.security_final',
    });

    const securityDone = new sfn.Pass(this, 'SecurityAgentDone');

    const checkSecurityScore1 = new sfn.Choice(this, 'CheckSecurityScoreIter1')
      .when(sfn.Condition.numberGreaterThanEquals('$.security_iteration_1.Payload.confidence', 0.85), securityDone)
      .otherwise(securityIter2);

    const checkSecurityScore2 = new sfn.Choice(this, 'CheckSecurityScoreIter2')
      .when(sfn.Condition.numberGreaterThanEquals('$.security_iteration_2.Payload.confidence', 0.80), securityDone)
      .otherwise(securityIter3.next(securityDone));

    securityIter1.next(checkSecurityScore1);
    securityIter2.next(checkSecurityScore2);

    // --------------------------------------------------------
    // Style SubAgent — Ralph Loop (3 iterations)
    // --------------------------------------------------------
    const styleIter1 = new tasks.LambdaInvoke(this, 'StyleAgentIteration1', {
      lambdaFunction: props.styleFn,
      payload: sfn.TaskInput.fromObject({
        session_id:        sfn.JsonPath.stringAt('$.orchestrator_result.Payload.session_id'),
        pr_metadata:       sfn.JsonPath.objectAt('$.orchestrator_result.Payload.pr_metadata'),
        diff_content:      sfn.JsonPath.stringAt('$.orchestrator_result.Payload.diff_content'),
        iteration:         1,
        previous_findings: null,
      }),
      resultPath: '$.style_iteration_1',
    }).addRetry({ errors: ['Lambda.ServiceException'], maxAttempts: 2, interval: cdk.Duration.seconds(2), backoffRate: 2 });

    const styleIter2 = new tasks.LambdaInvoke(this, 'StyleAgentIteration2', {
      lambdaFunction: props.styleFn,
      payload: sfn.TaskInput.fromObject({
        session_id:        sfn.JsonPath.stringAt('$.orchestrator_result.Payload.session_id'),
        pr_metadata:       sfn.JsonPath.objectAt('$.orchestrator_result.Payload.pr_metadata'),
        diff_content:      sfn.JsonPath.stringAt('$.orchestrator_result.Payload.diff_content'),
        iteration:         2,
        previous_findings: sfn.JsonPath.objectAt('$.style_iteration_1.Payload.findings'),
      }),
      resultPath: '$.style_iteration_2',
    });

    const styleIter3 = new tasks.LambdaInvoke(this, 'StyleAgentIteration3', {
      lambdaFunction: props.styleFn,
      payload: sfn.TaskInput.fromObject({
        session_id:        sfn.JsonPath.stringAt('$.orchestrator_result.Payload.session_id'),
        pr_metadata:       sfn.JsonPath.objectAt('$.orchestrator_result.Payload.pr_metadata'),
        diff_content:      sfn.JsonPath.stringAt('$.orchestrator_result.Payload.diff_content'),
        iteration:         3,
        previous_findings: sfn.JsonPath.objectAt('$.style_iteration_2.Payload.findings'),
      }),
      resultPath: '$.style_final',
    });

    const styleDone = new sfn.Pass(this, 'StyleAgentDone');

    const checkStyleScore1 = new sfn.Choice(this, 'CheckStyleScoreIter1')
      .when(sfn.Condition.numberGreaterThanEquals('$.style_iteration_1.Payload.confidence', 0.85), styleDone)
      .otherwise(styleIter2);

    const checkStyleScore2 = new sfn.Choice(this, 'CheckStyleScoreIter2')
      .when(sfn.Condition.numberGreaterThanEquals('$.style_iteration_2.Payload.confidence', 0.80), styleDone)
      .otherwise(styleIter3.next(styleDone));

    styleIter1.next(checkStyleScore1);
    styleIter2.next(checkStyleScore2);

    // --------------------------------------------------------
    // Parallel — Run both SubAgents simultaneously
    // --------------------------------------------------------
    const runInParallel = new sfn.Parallel(this, 'RunSubAgentsInParallel', {
      resultPath: '$.parallel_results',
    });
    runInParallel.branch(securityIter1);
    runInParallel.branch(styleIter1);
    runInParallel.addCatch(handleSubAgentFailure, { resultPath: '$.error' });

    // --------------------------------------------------------
    // Aggregate findings
    // --------------------------------------------------------
    const aggregateFindings = new tasks.LambdaInvoke(this, 'AggregateFindings', {
      lambdaFunction: props.aggregatorFn,
      payload: sfn.TaskInput.fromObject({
        session_id:      sfn.JsonPath.stringAt('$.orchestrator_result.Payload.session_id'),
        pr_metadata:     sfn.JsonPath.objectAt('$.orchestrator_result.Payload.pr_metadata'),
        security_output: sfn.JsonPath.objectAt('$.parallel_results[0]'),
        style_output:    sfn.JsonPath.objectAt('$.parallel_results[1]'),
      }),
      resultPath: '$.aggregator_result',
      taskTimeout: sfn.Timeout.duration(cdk.Duration.seconds(60)),
    }).addRetry({
      errors:      ['Lambda.ServiceException'],
      maxAttempts: 2,
      interval:    cdk.Duration.seconds(2),
      backoffRate: 2,
    }).addCatch(handleAggregatorFailure, { resultPath: '$.error' });

    // --------------------------------------------------------
    // Check final verdict
    // --------------------------------------------------------
    const checkFinalVerdict = new sfn.Choice(this, 'CheckFinalVerdict')
      .when(sfn.Condition.stringEquals('$.aggregator_result.Payload.final_verdict', 'ESCALATED'), notifySlack)
      .otherwise(reviewComplete);

    // --------------------------------------------------------
    // Check eligibility routing
    // --------------------------------------------------------
    const checkEligibility = new sfn.Choice(this, 'CheckEligibility')
      .when(sfn.Condition.stringEquals('$.orchestrator_result.Payload.status', 'SKIPPED'), postSizeWarning)
      .when(sfn.Condition.stringEquals('$.orchestrator_result.Payload.status', 'ESCALATED'), notifySlack)
      .when(sfn.Condition.booleanEquals('$.orchestrator_result.Payload.eligible', true),
        runInParallel.next(aggregateFindings).next(checkFinalVerdict)
      )
      .otherwise(reviewFailed);

    // --------------------------------------------------------
    // State Machine Definition
    // --------------------------------------------------------
    const definition = validateEligibility.next(checkEligibility);

    const logGroup = new logs.LogGroup(this, 'StateMachineLogs', {
      logGroupName:  `/aws/states/pr-review-pipeline-${props.appEnv}`,
      retention:     logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Role is auto-created by CDK inside this stack. tasks.LambdaInvoke
    // will grant `lambda:InvokeFunction` per function — keeping those
    // grants in the same stack as the Lambda refs avoids the
    // IAM → LambdaAPI cross-stack cycle.
    this.stateMachine = new sfn.StateMachine(this, 'PRReviewPipeline', {
      stateMachineName: `pr-review-pipeline-${props.appEnv}`,
      definition,
      tracingEnabled:   true,
      logs: {
        destination:          logGroup,
        level:                sfn.LogLevel.ALL,
        includeExecutionData: true,
      },
      timeout: cdk.Duration.minutes(10),
    });

    // --------------------------------------------------------
    // CloudFormation Outputs
    // --------------------------------------------------------
    new cdk.CfnOutput(this, 'StateMachineArn', {
      value:      this.stateMachine.stateMachineArn,
      exportName: `PRReviewStateMachineArn-${props.appEnv}`,
    });
  }
}