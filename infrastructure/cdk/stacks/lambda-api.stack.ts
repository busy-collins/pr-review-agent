import * as path        from 'path';
import * as cdk        from 'aws-cdk-lib';
import * as lambda      from 'aws-cdk-lib/aws-lambda';
import * as apigateway  from 'aws-cdk-lib/aws-apigateway';
import * as iam         from 'aws-cdk-lib/aws-iam';
import * as dynamodb    from 'aws-cdk-lib/aws-dynamodb';
import * as logs        from 'aws-cdk-lib/aws-logs';
import { Construct }    from 'constructs';

interface LambdaAPIStackProps extends cdk.StackProps {
  appEnv:              string;
  tags:                Record<string, string>;
  lambdaExecutionRole: iam.Role;
  sessionTable:        dynamodb.Table;
  rateLimitTable:      dynamodb.Table;
}

// ============================================================
// Lambda + API Gateway Stack
// Four agent Lambdas + one webhook receiver
// API Gateway exposes the webhook endpoint publicly
// ============================================================
export class LambdaAPIStack extends cdk.Stack {

  public readonly orchestratorFn: lambda.Function;
  public readonly securityFn:     lambda.Function;
  public readonly styleFn:        lambda.Function;
  public readonly aggregatorFn:   lambda.Function;
  public readonly webhookFn:      lambda.Function;
  public readonly api:            apigateway.RestApi;

  constructor(scope: Construct, id: string, props: LambdaAPIStackProps) {
    super(scope, id, props);

    // --------------------------------------------------------
    // Shared Lambda environment variables
    //
    // Secrets (ANTHROPIC_API_KEY, GITHUB_TOKEN, GITHUB_WEBHOOK_SECRET,
    // SLACK_BOT_TOKEN) are read from the developer's shell at synth
    // time via process.env. They MUST be exported before running
    // `cdk deploy` — see `.env.example` for the full contract.
    //
    // This is the "quick path" — values land in the Lambda config in
    // plain text. For production, migrate these to Secrets Manager
    // and grant the Lambda role `secretsmanager:GetSecretValue`.
    // --------------------------------------------------------
    const sharedEnv = {
      NODE_ENV:               props.appEnv,
      APP_ENV:                props.appEnv,
      AWS_ACCOUNT_ID:         this.account,
      DYNAMODB_TABLE_NAME:    props.sessionTable.tableName,
      RATE_LIMIT_TABLE_NAME:  props.rateLimitTable.tableName,
      CLAUDE_MODEL:           'claude-sonnet-4-6',
      MAX_DIFF_LINES:         '3000',
      MIN_CONFIDENCE_THRESHOLD: '0.75',
      MAX_RALPH_ITERATIONS:   '3',
      SESSION_TTL_SECONDS:    '172800',
      CLOUDWATCH_NAMESPACE:   'PRReviewAgent',
      LOG_LEVEL:              props.appEnv === 'production' ? 'info' : 'debug',
      // Shadow mode flag — when 'true' the Aggregator skips the GitHub
      // comment post. Flip to 'true' during the rollout window per
      // PLAN.md Phase 7, then back to 'false' for the real launch.
      SHADOW_MODE:            'false',
      // Secrets — pulled from the deploying shell. Empty-string
      // fallback keeps `cdk synth` working locally; the Lambda will
      // fail loudly at runtime if any are missing.
      ANTHROPIC_API_KEY:        process.env.ANTHROPIC_API_KEY        ?? '',
      GITHUB_TOKEN:             process.env.GITHUB_TOKEN             ?? '',
      GITHUB_WEBHOOK_SECRET:    process.env.GITHUB_WEBHOOK_SECRET    ?? '',
      SLACK_BOT_TOKEN:          process.env.SLACK_BOT_TOKEN          ?? '',
      SLACK_ESCALATION_CHANNEL: process.env.SLACK_ESCALATION_CHANNEL ?? '#pr-review-escalations',
    };

    // --------------------------------------------------------
    // Shared Lambda configuration. No `Partial<FunctionProps>` annotation —
    // that widens `runtime` to optional, and spreading then loses the
    // required-prop contract when passed into `new lambda.Function`.
    // --------------------------------------------------------
    const sharedLambdaProps = {
      runtime:      lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      role:         props.lambdaExecutionRole,
      environment:  sharedEnv,
      tracing:      lambda.Tracing.ACTIVE,
      logRetention: logs.RetentionDays.ONE_MONTH,
      memorySize:   512,
    } satisfies Partial<lambda.FunctionProps>;

    // --------------------------------------------------------
    // Lambda 1: Orchestrator
    // Validates PR, fetches diff, routes to SubAgents
    // Also handles failures, Slack notifications, size warnings
    // --------------------------------------------------------
    this.orchestratorFn = new lambda.Function(this, 'OrchestratorFn', {
      ...sharedLambdaProps,
      functionName: `pr-review-orchestrator-${props.appEnv}`,
      description:  'PR Review Agent — Orchestrator: validates PRs and coordinates pipeline',
      handler:      'agents/orchestrator/src/index.handler',
      code:         lambda.Code.fromAsset(path.resolve(__dirname, '../../../dist')),
      timeout:      cdk.Duration.seconds(60),
      memorySize:   256,
    });

    // --------------------------------------------------------
    // Lambda 2: Security SubAgent
    // Scans PR diff for vulnerabilities with Ralph loop
    // --------------------------------------------------------
    // Reserved concurrency intentionally omitted — new AWS accounts
    // start with a low Lambda concurrency quota (~10) and any reserve
    // would push UnreservedConcurrency below the required minimum.
    // Add back via `reservedConcurrentExecutions` after requesting a
    // quota increase if you need to cap fan-out in production.
    this.securityFn = new lambda.Function(this, 'SecurityFn', {
      ...sharedLambdaProps,
      functionName: `pr-review-security-agent-${props.appEnv}`,
      description:  'PR Review Agent — Security SubAgent: scans for vulnerabilities',
      handler:      'agents/security/src/index.handler',
      code:         lambda.Code.fromAsset(path.resolve(__dirname, '../../../dist')),
      timeout:      cdk.Duration.seconds(240),
      memorySize:   1024,
    });

    // --------------------------------------------------------
    // Lambda 3: Style SubAgent
    // Enforces coding standards with Ralph loop
    // --------------------------------------------------------
    this.styleFn = new lambda.Function(this, 'StyleFn', {
      ...sharedLambdaProps,
      functionName: `pr-review-style-agent-${props.appEnv}`,
      description:  'PR Review Agent — Style SubAgent: enforces coding standards',
      handler:      'agents/style/src/index.handler',
      code:         lambda.Code.fromAsset(path.resolve(__dirname, '../../../dist')),
      timeout:      cdk.Duration.seconds(240),
      memorySize:   1024,
    });

    // --------------------------------------------------------
    // Lambda 4: Aggregator
    // Merges findings, formats and posts GitHub comment
    // --------------------------------------------------------
    this.aggregatorFn = new lambda.Function(this, 'AggregatorFn', {
      ...sharedLambdaProps,
      functionName: `pr-review-aggregator-${props.appEnv}`,
      description:  'PR Review Agent — Aggregator: merges findings and posts PR comment',
      handler:      'agents/aggregator/src/index.handler',
      code:         lambda.Code.fromAsset(path.resolve(__dirname, '../../../dist')),
      timeout:      cdk.Duration.seconds(60),
      memorySize:   512,
    });

    // --------------------------------------------------------
    // Lambda 5: Webhook Handler
    // API Gateway invokes this — verifies signature, checks
    // rate limits, starts Step Functions execution
    // --------------------------------------------------------
    this.webhookFn = new lambda.Function(this, 'WebhookFn', {
      ...sharedLambdaProps,
      functionName: `pr-review-webhook-${props.appEnv}`,
      description:  'PR Review Agent — Webhook receiver for GitHub events',
      handler:      'api/webhook/index.handler',
      code:         lambda.Code.fromAsset(path.resolve(__dirname, '../../../dist')),
      timeout:      cdk.Duration.seconds(29),
      memorySize:   256,
    });

    // states:StartExecution for the webhook Lambda is granted in
    // IAMStack (on lambdaExecutionRole) to avoid cross-stack
    // IAM → LambdaAPI cycle.

    // --------------------------------------------------------
    // API Gateway — exposes /webhook endpoint
    // --------------------------------------------------------
    const apiLogGroup = new logs.LogGroup(this, 'APIGatewayLogs', {
      logGroupName:  `/aws/apigateway/pr-review-agent-${props.appEnv}`,
      retention:     logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.api = new apigateway.RestApi(this, 'PRReviewAPI', {
      restApiName:   `pr-review-api-${props.appEnv}`,
      description:   'PR Review Agent — GitHub webhook receiver',
      deployOptions: {
        stageName:          props.appEnv,
        tracingEnabled:     true,
        dataTraceEnabled:   props.appEnv !== 'production',
        loggingLevel:       apigateway.MethodLoggingLevel.INFO,
        accessLogDestination: new apigateway.LogGroupLogDestination(apiLogGroup),
        accessLogFormat:    apigateway.AccessLogFormat.jsonWithStandardFields(),
        throttlingRateLimit:  100,
        throttlingBurstLimit: 50,
      },
      // CORS intentionally not configured — this endpoint is invoked
      // server-to-server by GitHub, never from a browser.
    });

    // POST /webhook — GitHub sends events here
    const webhookResource = this.api.root.addResource('webhook');
    webhookResource.addMethod(
      'POST',
      new apigateway.LambdaIntegration(this.webhookFn, {
        timeout: cdk.Duration.seconds(29),
        proxy:   true,
      }),
      {
        apiKeyRequired: false,
        methodResponses: [
          { statusCode: '200' },
          { statusCode: '400' },
          { statusCode: '401' },
          { statusCode: '429' },
          { statusCode: '500' },
        ],
      }
    );

    // --------------------------------------------------------
    // CloudFormation Outputs
    // --------------------------------------------------------
    new cdk.CfnOutput(this, 'WebhookURL', {
      value:      `${this.api.url}webhook`,
      exportName: `PRReviewWebhookURL-${props.appEnv}`,
      description: 'Configure this URL as your GitHub App webhook endpoint',
    });

    new cdk.CfnOutput(this, 'OrchestratorFnArn', {
      value:      this.orchestratorFn.functionArn,
      exportName: `PRReviewOrchestratorArn-${props.appEnv}`,
    });
  }
}