import * as cdk      from 'aws-cdk-lib';
import * as ec2       from 'aws-cdk-lib/aws-ec2';
import * as rds       from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct }  from 'constructs';

interface RDSStackProps extends cdk.StackProps {
  appEnv: string;
  tags: Record<string, string>;
}

// ============================================================
// RDS Stack
// PostgreSQL with pgvector for long-term review history
// and similarity search across past findings
// ============================================================
export class RDSStack extends cdk.Stack {

  public readonly dbInstance: rds.DatabaseInstance;
  public readonly dbSecret:   secretsmanager.Secret;
  public readonly dbVpc:      ec2.Vpc;
  public readonly dbSG:       ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: RDSStackProps) {
    super(scope, id, props);

    // --------------------------------------------------------
    // VPC — isolated subnets for RDS security
    // --------------------------------------------------------
    this.dbVpc = new ec2.Vpc(this, 'PRReviewVPC', {
      vpcName:    `pr-review-vpc-${props.appEnv}`,
      maxAzs:     2,
      natGateways: 1,
      subnetConfiguration: [
        {
          name:       'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask:   24,
        },
        {
          name:       'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask:   24,
        },
        {
          name:       'Isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask:   24,
        },
      ],
    });

    // --------------------------------------------------------
    // Security Group — RDS only accepts Lambda connections
    // --------------------------------------------------------
    this.dbSG = new ec2.SecurityGroup(this, 'RDSSecurityGroup', {
      vpc:               this.dbVpc,
      securityGroupName: `pr-review-rds-sg-${props.appEnv}`,
      description:       'Security group for PR Review Agent RDS instance',
      allowAllOutbound:  false,
    });

    // Lambda SG will be granted access in Lambda stack
    // Only port 5432 PostgreSQL allowed inbound
    this.dbSG.addIngressRule(
      ec2.Peer.ipv4(this.dbVpc.vpcCidrBlock),
      ec2.Port.tcp(5432),
      'Allow PostgreSQL from within VPC only'
    );

    // --------------------------------------------------------
    // Database Credentials — stored in Secrets Manager
    // --------------------------------------------------------
    this.dbSecret = new secretsmanager.Secret(this, 'DBSecret', {
      secretName:  `pr-review-agent/${props.appEnv}/rds-credentials`,
      description: 'RDS PostgreSQL credentials for PR Review Agent',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'pr_agent' }),
        generateStringKey:    'password',
        excludeCharacters:    '"@/\\\'',
        passwordLength:       32,
      },
    });

    // --------------------------------------------------------
    // RDS PostgreSQL Instance
    // db.t3.medium — sufficient for pgvector similarity search
    // Upgrade to db.r6g.large when review volume exceeds 10k/day
    // --------------------------------------------------------
    this.dbInstance = new rds.DatabaseInstance(this, 'PRReviewDB', {
      instanceIdentifier: `pr-review-db-${props.appEnv}`,

      // PostgreSQL 15 — supports pgvector extension
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_15,
      }),

      instanceType: props.appEnv === 'production'
        ? ec2.InstanceType.of(ec2.InstanceClass.R6G, ec2.InstanceSize.LARGE)
        : ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),

      vpc:           this.dbVpc,
      vpcSubnets:    { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.dbSG],

      credentials: rds.Credentials.fromSecret(this.dbSecret),

      databaseName:      'pr_review_history',
      port:              5432,

      // Storage
      allocatedStorage:    20,
      maxAllocatedStorage: 100,
      storageType:         rds.StorageType.GP3,
      storageEncrypted:    true,

      // Backups
      backupRetention:         props.appEnv === 'production'
        ? cdk.Duration.days(7)
        : cdk.Duration.days(1),
      deleteAutomatedBackups:  props.appEnv !== 'production',
      deletionProtection:      props.appEnv === 'production',
      removalPolicy:           props.appEnv === 'production'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,

      // Performance Insights — production only
      enablePerformanceInsights: props.appEnv === 'production',

      // Maintenance window
      preferredMaintenanceWindow: 'Sun:03:00-Sun:04:00',
      preferredBackupWindow:      '02:00-03:00',

      // Parameter group enabling pgvector
      parameterGroup: new rds.ParameterGroup(this, 'PGVectorParamGroup', {
        engine: rds.DatabaseInstanceEngine.postgres({
          version: rds.PostgresEngineVersion.VER_15,
        }),
        description: 'Parameter group enabling pgvector shared_preload_libraries',
        parameters: {
          shared_preload_libraries: 'pg_stat_statements',
          log_min_duration_statement: '1000',
          log_connections: '1',
        },
      }),

      cloudwatchLogsExports:        ['postgresql'],
      cloudwatchLogsRetention:      cdk.aws_logs.RetentionDays.ONE_MONTH,
      monitoringInterval:           cdk.Duration.seconds(60),
    });

    // --------------------------------------------------------
    // CloudFormation Outputs
    // --------------------------------------------------------
    new cdk.CfnOutput(this, 'DBEndpoint', {
      value:      this.dbInstance.dbInstanceEndpointAddress,
      exportName: `PRReviewDBEndpoint-${props.appEnv}`,
    });

    new cdk.CfnOutput(this, 'DBSecretArn', {
      value:      this.dbSecret.secretArn,
      exportName: `PRReviewDBSecretArn-${props.appEnv}`,
    });

    new cdk.CfnOutput(this, 'VpcId', {
      value:      this.dbVpc.vpcId,
      exportName: `PRReviewVpcId-${props.appEnv}`,
    });
  }
}