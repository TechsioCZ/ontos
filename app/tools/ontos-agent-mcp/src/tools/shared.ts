import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Predicate, Schema } from 'effect';
import { z } from 'zod';
import { callAction, OntosRequestError, readRecords } from '../ontos-client.ts';
import type { JsonObject } from '../ontos-client.ts';
import { RevisionWire } from './wire.ts';

/** Audiences: stable vertical app IDs (directory names under app/verticals). */
export const VERTICAL = {
  merchandise: 'merchandise',
  partyRegistry: 'party-registry',
  salesPipeline: 'sales-pipeline',
  siamparkBilling: 'siampark-billing-finance',
  siamparkWork: 'siampark-work',
  tagging: 'tagging',
  workforce: 'workforce',
} as const;

/** Money on the wire is integer CZK minor units (haléře); tools speak CZK. */
export const czkFromMinor = (minor: number): number => Math.round(minor) / 100;
export const minorFromCzk = (czk: number): number => Math.round(czk * 100);

export const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/u;

export const jsonResult = <A>(value: A) => ({
  content: [{ text: JSON.stringify(value), type: 'text' as const }],
  isError: false,
});

export const errorResult = (message: string) => ({
  content: [{ text: message, type: 'text' as const }],
  isError: true,
});

/** Human-readable tool error. 403 reads "Agent nemá oprávnění: …"; every HTTP error keeps its status and code. */
export const describeError = (cause: unknown): string => {
  if (Schema.is(OntosRequestError)(cause)) {
    const detail = cause.detail ?? cause.title ?? 'bez podrobností';
    const code = cause.code === undefined ? '' : `, kód ${cause.code}`;
    if (cause.status === 403) {
      return `Agent nemá oprávnění: ${detail} (HTTP 403${code})`;
    }
    return `HTTP ${cause.status}${code}: ${detail}`;
  }
  return Predicate.isError(cause) ? cause.message : String(cause);
};

/** Runs one tool body and turns any failure into an MCP tool error. Never writes to stdout. */
export const runTool = async <A>(body: () => Promise<A>) => {
  try {
    return jsonResult(await body());
  } catch (error) {
    process.stderr.write(`tool failed: ${describeError(error)}\n`);
    return errorResult(describeError(error));
  }
};

/** Registers one tool whose input is validated by a zod shape before the body runs. */
export const defineTool = <Fields extends Readonly<Record<string, z.ZodType>>, A>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: Fields,
  body: (input: z.infer<z.ZodObject<Fields>>) => Promise<A>,
): void => {
  // The SDK's generic callback type does not resolve for a generic shape, so the shape is widened here.
  const widened: Readonly<Record<string, z.ZodType>> = inputSchema;
  const parseInput = z.object(inputSchema);
  // The SDK has validated the arguments already; parsing again yields the typed value without a cast.
  server.registerTool(
    name,
    { description, inputSchema: widened },
    async (rawInput) => await runTool(async () => await body(parseInput.parse(rawInput))),
  );
};

/** Records read: POST {vertical}/reads/records. The response is decoded by `schema`. */
export const readRecordsOf = async <S extends Schema.Codec<unknown>>(
  vertical: string,
  schema: S,
  query: JsonObject = {},
): Promise<S['Type']> => await readRecords(vertical, 'records', query, schema);

export const readRevision = async (vertical: string, query: JsonObject = {}): Promise<number> => {
  const response = await readRecordsOf(vertical, RevisionWire, query);
  return response.revision;
};

const isRevisionConflict = (cause: unknown): boolean =>
  Schema.is(OntosRequestError)(cause) && cause.status === 409 && (cause.code ?? '').endsWith('revision_conflict');

/**
 * Sends one apply-command with expectedRevision. Uses `expectedRevision` when the caller already knows it,
 * otherwise reads the current revision first. On a revision conflict it re-reads and retries exactly once.
 * `idempotencyKey` (optional) makes a repeated logical request execute at most once.
 */
export const applyCommand = async <S extends Schema.Codec<unknown>>(
  vertical: string,
  schema: S,
  command: JsonObject,
  currentRevision: () => Promise<number>,
  expectedRevision?: number,
  idempotencyKey?: string,
): Promise<S['Type']> => {
  const send = async (revision: number, key: string | undefined) =>
    await callAction(vertical, 'apply-command', { command, expectedRevision: revision }, schema, key);
  try {
    return await send(expectedRevision ?? (await currentRevision()), idempotencyKey);
  } catch (error) {
    if (!isRevisionConflict(error)) {
      throw error;
    }
    // The rejected attempt keeps its key; the retry is a new request body, so it needs its own stable key.
    return await send(await currentRevision(), idempotencyKey === undefined ? undefined : `${idempotencyKey}-retry`);
  }
};

/** Core answers 409 with one of these codes when an idempotency key was already used: the request ran once. */
export const isIdempotentReplay = (cause: unknown): boolean =>
  Schema.is(OntosRequestError)(cause) &&
  cause.status === 409 &&
  /already_committed|request_hash_conflict/u.test(cause.code ?? '');
