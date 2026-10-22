/**
 * MCP outputSchema of the tools (design §5.3). Kept loose (extra fields allowed) because clients validate
 * structuredContent against it; only the fields the model relies on are listed.
 */
import type { JsonObject as JsonSchema } from "./catalog.ts";

const STRING = { type: 'string' } as const;
const ANY = {} as const;

export const READ_OUTPUT: JsonSchema = {
  additionalProperties: true,
  properties: {
    data: ANY,
    id: STRING,
    legalEntityId: STRING,
    noteCs: STRING,
    omitted: {
      items: {
        additionalProperties: true,
        properties: { count: { type: 'integer' }, kind: { enum: ['list', 'object'] }, path: STRING },
        type: 'object',
      },
      type: 'array',
    },
    path: STRING,
    truncated: {
      items: {
        additionalProperties: true,
        properties: {
          offset: { type: 'integer' },
          path: STRING,
          returned: { type: 'integer' },
          total: { type: 'integer' },
        },
        type: 'object',
      },
      type: 'array',
    },
  },
  required: ['id', 'data', 'truncated', 'omitted'],
  type: 'object',
};

export const WRITE_OUTPUT: JsonSchema = {
  additionalProperties: true,
  properties: {
    batchId: STRING,
    messageCs: STRING,
    proposalId: STRING,
    proposalIds: { items: STRING, type: 'array' },
    replayed: { type: 'boolean' },
    result: ANY,
    reviewUrl: STRING,
    status: { enum: ['executed', 'proposed'] },
    url: STRING,
  },
  required: ['status', 'messageCs'],
  type: 'object',
};

export const WHOAMI_OUTPUT: JsonSchema = {
  additionalProperties: true,
  properties: {
    acting: { additionalProperties: true, type: 'object' },
    client: { additionalProperties: true, type: 'object' },
    company: { additionalProperties: true, type: 'object' },
    modules: { items: { additionalProperties: true, type: 'object' }, type: 'array' },
    profile_id: STRING,
    reviewUrl: STRING,
    writePolicy: { enum: ['read_only', 'approval', 'direct'] },
    writePolicyCs: STRING,
  },
  required: ['profile_id', 'company', 'acting', 'modules', 'writePolicy'],
  type: 'object',
};

export const CAPABILITIES_OUTPUT: JsonSchema = {
  additionalProperties: true,
  description: 'Seznam modulů ({modules}) nebo popis jedné položky ({id, inputSchema}).',
  properties: {
    hint: STRING,
    id: STRING,
    inputSchema: { additionalProperties: true, type: 'object' },
    kind: { enum: ['read', 'action'] },
    modules: { items: { additionalProperties: true, type: 'object' }, type: 'array' },
    writable: { type: 'boolean' },
    writePolicy: { enum: ['read_only', 'approval', 'direct'] },
  },
  type: 'object',
};

export const PROPOSALS_OUTPUT: JsonSchema = {
  additionalProperties: true,
  properties: {
    batches: { items: { additionalProperties: true, type: 'object' }, type: 'array' },
    pendingCount: { type: 'number' },
    reviewUrl: STRING,
  },
  required: ['batches', 'pendingCount'],
  type: 'object',
};
