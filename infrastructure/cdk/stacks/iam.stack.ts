import * as cdk  from 'aws-cdk-lib';
import * as iam  from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

interface IAMStackProps extends cdk.StackProps {
  appEnv: string;
  tags: Record<string, string>;
}

// ============================================================
// IAM Stack
// Defines least-privilege roles for every Lambda and
// Step Functions in the pipeline
// ============================================================
export class IAMStack extends cdk.Stack {

  public readonly lambdaExecutionRole: iam.Role;
  public readonly stepFunctionsRole:   iam.Role;
  public readonly apiGatewayRole:      iam.Role;

  constructor(scope: Construct, id: string, props: IAMStackProps) {
    super(scope, id, props);

    // --------------------------------------------------------
    // Lambda Execution Role
    // Shared by all four agent Lambda functions
    // --------------------------------------------------------
    this.lambdaExecutionRole = new iam.Role(this, 'LambdaExecutionRole', {
      roleName: `pr-review-lambda-role-${props.appEnv}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for all PR Review Agent Lambda functions',
    });

    // Basic Lambda execution — CloudWatch Logs
    this.lambdaExecutionRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
    );

    // X-Ray tracing
    this.lambdaExecutionRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AWSXRayDaemonWriteAccess')
    );

    // DynamoDB — session and rate limit tables only
    this.lambdaExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'DynamoDBSessionAccess',
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:Query',
        'dynamodb:DeleteItem',
      ],
      resources: [
        `arn:aws:dynamodb:${this.region}:${this.account}:table/pr-review-sessions-${props.appEnv}`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/pr-review-sessions-${props.appEnv}/index/*`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/pr-review-rate-limits-${props.appEnv}`,
      ],
    }));

    // Secrets Manager — read-only for API keys
    this.lambdaExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SecretsManagerReadOnly',
      effect: iam.Effect.ALLOW,
      actions: [
        'secretsmanager:GetSecretValue',
      ],
      resources: [
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:pr-review-agent/*`,
      ],
    }));

    // SSM Parameter Store — read configuration
    this.lambdaExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SSMParameterRead',
      effect: iam.Effect.ALLOW,
      actions: [
        'ssm:GetParameter',
        'ssm:GetParameters',
      ],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/pr-review-agent/${props.appEnv}/*`,
      ],
    }));

    // CloudWatch Metrics — publish custom metrics
    this.lambdaExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CloudWatchMetrics',
      effect: iam.Effect.ALLOW,
      actions: [
        'cloudwatch:PutMetricData',
      ],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'cloudwatch:namespace': 'PRReviewAgent',
        },
      },
    }));

    // Step Functions — webhook Lambda starts pipeline executions.
    // Defined here (not in LambdaAPIStack) to avoid a cross-stack
    // IAM → LambdaAPI cycle when mutating the role from outside.
    this.lambdaExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'StartPipelineExecution',
      effect: iam.Effect.ALLOW,
      actions: ['states:StartExecution'],
      resources: [
        `arn:aws:states:${this.region}:${this.account}:stateMachine:pr-review-pipeline-${props.appEnv}`,
      ],
    }));

    // --------------------------------------------------------
    // Step Functions Execution Role
    // Allows Step Functions to invoke Lambda functions
    // --------------------------------------------------------
    this.stepFunctionsRole = new iam.Role(this, 'StepFunctionsRole', {
      roleName: `pr-review-stepfn-role-${props.appEnv}`,
      assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
      description: 'Execution role for PR Review Agent Step Functions state machine',
    });

    // Invoke Lambda functions
    this.stepFunctionsRole.addToPolicy(new iam.PolicyStatement({
      sid: 'InvokeLambdaFunctions',
      effect: iam.Effect.ALLOW,
      actions: [
        'lambda:InvokeFunction',
      ],
      resources: [
        `arn:aws:lambda:${this.region}:${this.account}:function:pr-review-*-${props.appEnv}`,
      ],
    }));

    // CloudWatch Logs for Step Functions execution history
    this.stepFunctionsRole.addToPolicy(new iam.PolicyStatement({
      sid: 'StepFunctionsLogging',
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:CreateLogDelivery',
        'logs:GetLogDelivery',
        'logs:UpdateLogDelivery',
        'logs:DeleteLogDelivery',
        'logs:ListLogDeliveries',
        'logs:PutResourcePolicy',
        'logs:DescribeResourcePolicies',
        'logs:DescribeLogGroups',
      ],
      resources: ['*'],
    }));

    // X-Ray for Step Functions
    this.stepFunctionsRole.addToPolicy(new iam.PolicyStatement({
      sid: 'XRayTracing',
      effect: iam.Effect.ALLOW,
      actions: [
        'xray:PutTraceSegments',
        'xray:PutTelemetryRecords',
        'xray:GetSamplingRules',
        'xray:GetSamplingTargets',
      ],
      resources: ['*'],
    }));

    // --------------------------------------------------------
    // API Gateway Role
    // Allows API Gateway to start Step Functions executions
    // --------------------------------------------------------
    this.apiGatewayRole = new iam.Role(this, 'APIGatewayRole', {
      roleName: `pr-review-apigw-role-${props.appEnv}`,
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      description: 'Role for API Gateway to invoke Lambda webhook handler',
    });

    this.apiGatewayRole.addToPolicy(new iam.PolicyStatement({
      sid: 'InvokeWebhookLambda',
      effect: iam.Effect.ALLOW,
      actions: ['lambda:InvokeFunction'],
      resources: [
        `arn:aws:lambda:${this.region}:${this.account}:function:pr-review-webhook-${props.appEnv}`,
      ],
    }));

    // --------------------------------------------------------
    // Outputs
    // --------------------------------------------------------
    new cdk.CfnOutput(this, 'LambdaRoleArn', {
      value: this.lambdaExecutionRole.roleArn,
      exportName: `PRReviewLambdaRoleArn-${props.appEnv}`,
    });

    new cdk.CfnOutput(this, 'StepFnRoleArn', {
      value: this.stepFunctionsRole.roleArn,
      exportName: `PRReviewStepFnRoleArn-${props.appEnv}`,
    });
  }
}