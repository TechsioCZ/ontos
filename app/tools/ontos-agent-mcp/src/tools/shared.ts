import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';
import { callAction, OntosRequestError, readRecords } from '../ontos-client.ts';

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

export type JsonObject = Record<string, unknown>;

export function jsonResult(value: unknown) {
  return { content: [{ text: JSON.stringify(value), type: 'text' as const }], isError: false };
}

export function errorResult(message: string) {
  return { content: [{ text: message, type: 'text' as const }], isError: true };
}

/** Human-readable tool error. 403 reads "Agent nemá oprávnění: …"; every HTTP error keeps its status and code. */
export function describeError(error: unknown): string {
  if (error instanceof OntosRequestError) {
    const detail = error.detail ?? error.title ?? 'bez podrobností';
    const code = error.code === undefined ? '' : `, kód ${error.code}`;
    if (error.status === 403) {
      return `Agent nemá oprávnění: ${detail} (HTTP 403${code})`;
    }
    return `HTTP ${error.status}${code}: ${detail}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Runs one tool body and turns any failure into an MCP tool error. Never writes to stdout. */
export async function runTool(body: () => Promise<unknown>) {
  try {
    return jsonResult(await body());
  } catch (error) {
    console.error(`tool failed: ${describeError(error)}`);
    return errorResult(describeError(error));
  }
}

/** Registers one tool whose input is validated by a zod shape before the body runs. */
export function defineTool<Shape extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: Shape,
  body: (input: z.infer<z.ZodObject<Shape>>) => Promise<unknown>,
): void {
  // The SDK's generic callback type does not resolve for a generic shape, so the shape is widened here.
  const shape: z.ZodRawShape = inputSchema;
  server.registerTool(name, { description, inputSchema: shape }, (input: unknown) =>
    runTool(() => body(input as z.infer<z.ZodObject<Shape>>)),
  );
}

/** Records read: POST {vertical}/reads/records. The response shape is typed by the caller. */
export async function readRecordsOf<T>(vertical: string, query: JsonObject = {}): Promise<T> {
  return (await readRecords(vertical, 'records', query)) as T;
}

export async function readRevision(vertical: string, query: JsonObject = {}): Promise<number> {
  return (await readRecordsOf<{ revision: number }>(vertical, query)).revision;
}

function isRevisionConflict(error: unknown): boolean {
  return error instanceof OntosRequestError && error.status === 409 && (error.code ?? '').endsWith('revision_conflict');
}

/**
 * Sends one apply-command with expectedRevision. Uses `expectedRevision` when the caller already knows it,
 * otherwise reads the current revision first. On a revision conflict it re-reads and retries exactly once.
 */
export async function applyCommand<R extends { readonly revision: number }>(
  vertical: string,
  command: JsonObject,
  currentRevision: () => Promise<number>,
  expectedRevision?: number,
): Promise<R> {
  const send = async (revision: number) =>
    (await callAction(vertical, 'apply-command', { command, expectedRevision: revision })) as R;
  try {
    return await send(expectedRevision ?? (await currentRevision()));
  } catch (error) {
    if (!isRevisionConflict(error)) {
      throw error;
    }
    return send(await currentRevision());
  }
}
