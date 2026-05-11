import {
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { log } from './logger';
import type { CheckpointStage, PRMetadata, SessionStatus } from './types';

// ============================================================
// DynamoDB checkpoint reader/writer for session table.
// One row per (session_id, checkpoint_stage). TTL set to 48h.
// ============================================================

const dynamo = new DynamoDBClient(
  process.env.AWS_REGION ? { region: process.env.AWS_REGION } : {}
);

const SESSION_TABLE = process.env.DYNAMODB_TABLE_NAME || 'pr-review-sessions';
const SESSION_TTL_SECONDS = parseInt(
  process.env.SESSION_TTL_SECONDS || '172800',
  10
);

export interface CheckpointWrite {
  sessionId: string;
  stage: CheckpointStage;
  status: SessionStatus;
  prMetadata?: PRMetadata;
  data?: Record<string, unknown>;
}

export async function writeCheckpoint(input: CheckpointWrite): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const nowIso = new Date().toISOString();
  const item: Record<string, AttributeValue> = {
    session_id:       { S: input.sessionId },
    checkpoint_stage: { S: input.stage },
    status:           { S: input.status },
    updated_at:       { S: nowIso },
    ttl:              { N: String(now + SESSION_TTL_SECONDS) },
  };

  // Orchestrator owns session creation — only this stage writes created_at
  if (input.stage === 'ORCHESTRATOR') {
    item['created_at'] = { S: nowIso };
  }

  if (input.prMetadata) {
    item['pr_number'] = { N: String(input.prMetadata.pr_number) };
    item['repo']      = { S: input.prMetadata.repo };
    item['sender']    = { S: input.prMetadata.sender };
  }

  if (input.data) {
    for (const [key, value] of Object.entries(input.data)) {
      const attr = toAttributeValue(value);
      if (attr) item[key] = attr;
    }
  }

  try {
    await dynamo.send(new PutItemCommand({ TableName: SESSION_TABLE, Item: item }));
    return true;
  } catch (error) {
    log('ERROR', 'dynamo', 'Failed to write checkpoint', {
      sessionId: input.sessionId,
      stage: input.stage,
      error: error instanceof Error ? error.message : 'Unknown',
    });
    return false;
  }
}

export async function readCheckpoints(
  sessionId: string
): Promise<Record<string, unknown>[]> {
  try {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: SESSION_TABLE,
        KeyConditionExpression: 'session_id = :sid',
        ExpressionAttributeValues: { ':sid': { S: sessionId } },
      })
    );
    return (result.Items ?? []).map(unwrapItem);
  } catch (error) {
    log('ERROR', 'dynamo', 'Failed to read checkpoints', {
      sessionId,
      error: error instanceof Error ? error.message : 'Unknown',
    });
    return [];
  }
}

function toAttributeValue(value: unknown): AttributeValue | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return { S: value };
  if (typeof value === 'number') return { N: String(value) };
  if (typeof value === 'boolean') return { BOOL: value };
  return { S: JSON.stringify(value) };
}

function unwrapItem(item: Record<string, AttributeValue>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (value.S !== undefined) result[key] = value.S;
    else if (value.N !== undefined) result[key] = Number(value.N);
    else if (value.BOOL !== undefined) result[key] = value.BOOL;
  }
  return result;
}
