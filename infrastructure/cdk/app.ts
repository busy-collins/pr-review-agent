#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { IAMStack }          from './stacks/iam.stack';
import { DynamoDBStack }     from './stacks/dynamodb.stack';
import { RDSStack }          from './stacks/rds.stack';
import { LambdaAPIStack }    from './stacks/lambda-api.stack';
import { StepFunctionsStack } from './stacks/stepfunctions-stack';
import { CloudWatchStack }   from './stacks/cloud-watch-stack';

const app = new cdk.App();

const env = app.node.tryGetContext('env') || 'staging';

const awsEnv = {
  account: process.env.AWS_ACCOUNT_ID,
  region:  process.env.AWS_REGION ?? 'us-east-1',
};

const tags = {
  Project:     'pr-review-agent',
  Environment: env,
  ManagedBy:   'cdk',
};

// ============================================================
// Stack deployment order matters — dependencies flow top down
// ============================================================

// 1. IAM first — all other stacks reference these roles
const iamStack = new IAMStack(app, `PRReviewAgent-IAM-${env}`, {
  env: awsEnv,
  tags,
  appEnv: env,
});

// 2. DynamoDB — no dependencies
const dynamoStack = new DynamoDBStack(app, `PRReviewAgent-DynamoDB-${env}`, {
  env: awsEnv,
  tags,
  appEnv: env,
});

// 3. RDS — no dependencies. Returned construct isn't referenced; CDK still
// synthesizes the stack because we constructed it inside `app`.
new RDSStack(app, `PRReviewAgent-RDS-${env}`, {
  env: awsEnv,
  tags,
  appEnv: env,
});

// 4. Lambda + API Gateway — depends on IAM + DynamoDB
const lambdaStack = new LambdaAPIStack(app, `PRReviewAgent-LambdaAPI-${env}`, {
  env: awsEnv,
  tags,
  appEnv: env,
  lambdaExecutionRole: iamStack.lambdaExecutionRole,
  sessionTable:        dynamoStack.sessionTable,
  rateLimitTable:      dynamoStack.rateLimitTable,
});
lambdaStack.addDependency(iamStack);
lambdaStack.addDependency(dynamoStack);

// 5. Step Functions — depends on Lambda only. The state machine
// role is auto-created inside StepFunctionsStack so per-Lambda
// grants don't punch a cross-stack reference back into IAM.
const stepFnStack = new StepFunctionsStack(app, `PRReviewAgent-StepFunctions-${env}`, {
  env: awsEnv,
  tags,
  appEnv: env,
  orchestratorFn: lambdaStack.orchestratorFn,
  securityFn:     lambdaStack.securityFn,
  styleFn:        lambdaStack.styleFn,
  aggregatorFn:   lambdaStack.aggregatorFn,
});
stepFnStack.addDependency(lambdaStack);

// 6. CloudWatch — depends on all stacks for alarms + dashboards
const cloudWatchStack = new CloudWatchStack(app, `PRReviewAgent-CloudWatch-${env}`, {
  env: awsEnv,
  tags,
  appEnv: env,
  orchestratorFn:  lambdaStack.orchestratorFn,
  securityFn:      lambdaStack.securityFn,
  styleFn:         lambdaStack.styleFn,
  aggregatorFn:    lambdaStack.aggregatorFn,
  stateMachine:    stepFnStack.stateMachine,
  sessionTable:    dynamoStack.sessionTable,
});
cloudWatchStack.addDependency(lambdaStack);
cloudWatchStack.addDependency(stepFnStack);

// Frontend hosting (S3 + CloudFront) is owned by Terraform — see
// `terraform/frontend/`. Do not add a CDK frontend stack here.

app.synth();