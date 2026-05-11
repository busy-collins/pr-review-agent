import * as cdk      from 'aws-cdk-lib';
import * as dynamodb  from 'aws-cdk-lib/aws-dynamodb';
import { Construct }  from 'constructs';

interface DynamoDBStackProps extends cdk.StackProps {
  appEnv: string;
  tags: Record<string, string>;
}

// ============================================================
// DynamoDB Stack
// Two tables: session checkpoints + rate limiting
// ============================================================
export class DynamoDBStack extends cdk.Stack {

  public readonly sessionTable:   dynamodb.Table;
  public readonly rateLimitTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: DynamoDBStackProps) {
    super(scope, id, props);

    // --------------------------------------------------------
    // Table 1: pr-review-sessions
    // Stores checkpoint state for every active PR review
    // --------------------------------------------------------
    this.sessionTable = new dynamodb.Table(this, 'SessionTable', {
      tableName:    `pr-review-sessions-${props.appEnv}`,
      billingMode:  dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: props.appEnv === 'production'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,

      // Composite primary key
      partitionKey: {
        name: 'session_id',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'checkpoint_stage',
        type: dynamodb.AttributeType.STRING,
      },

      // TTL — DynamoDB auto-deletes records after 48 hours
      timeToLiveAttribute: 'ttl',

      // Point-in-time recovery for production
      pointInTimeRecovery: props.appEnv === 'production',

      // Encryption at rest
      encryption: dynamodb.TableEncryption.AWS_MANAGED,

      // Streams for archiving to RDS before TTL deletion
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });

    // GSI 1 — RepoIndex: query all reviews for a repository
    this.sessionTable.addGlobalSecondaryIndex({
      indexName: 'RepoIndex',
      partitionKey: {
        name: 'repo',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'created_at',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI 2 — PRNumberIndex: query all sessions for a specific PR
    this.sessionTable.addGlobalSecondaryIndex({
      indexName: 'PRNumberIndex',
      partitionKey: {
        name: 'pr_number',
        type: dynamodb.AttributeType.NUMBER,
      },
      sortKey: {
        name: 'created_at',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI 3 — StatusIndex: query by pipeline status for monitoring
    this.sessionTable.addGlobalSecondaryIndex({
      indexName: 'StatusIndex',
      partitionKey: {
        name: 'status',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'updated_at',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });

    // --------------------------------------------------------
    // Table 2: pr-review-rate-limits
    // Tracks request counts for rate limiting per repo/user/PR
    // --------------------------------------------------------
    this.rateLimitTable = new dynamodb.Table(this, 'RateLimitTable', {
      tableName:    `pr-review-rate-limits-${props.appEnv}`,
      billingMode:  dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,

      // Composite key: scope key + window start timestamp
      partitionKey: {
        name: 'rate_limit_key',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'window_start',
        type: dynamodb.AttributeType.NUMBER,
      },

      // TTL auto-cleans rate limit windows after they expire
      timeToLiveAttribute: 'ttl',

      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    // --------------------------------------------------------
    // CloudFormation Outputs
    // --------------------------------------------------------
    new cdk.CfnOutput(this, 'SessionTableName', {
      value:      this.sessionTable.tableName,
      exportName: `PRReviewSessionTableName-${props.appEnv}`,
    });

    new cdk.CfnOutput(this, 'SessionTableArn', {
      value:      this.sessionTable.tableArn,
      exportName: `PRReviewSessionTableArn-${props.appEnv}`,
    });

    new cdk.CfnOutput(this, 'SessionTableStreamArn', {
      value:      this.sessionTable.tableStreamArn ?? '',
      exportName: `PRReviewSessionTableStreamArn-${props.appEnv}`,
    });

    new cdk.CfnOutput(this, 'RateLimitTableName', {
      value:      this.rateLimitTable.tableName,
      exportName: `PRReviewRateLimitTableName-${props.appEnv}`,
    });
  }
}