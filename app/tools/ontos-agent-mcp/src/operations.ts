/**
 * Generic read and execute operations behind ontos_read and ontos_execute (lane mcp-gateway).
 * A write under the 'approval' policy never changes data: it becomes a proposal, either on the platform approvals
 * module or on the module's own AiProposeChanges.
 */
import { randomUUID } from 'node:crypto';
import { Result, Schema } from 'effect';
import type { Catalog, CatalogEntry, CatalogModule, ExecuteOutcome } from './capabilities/types.ts';
import { callAction, readRecords } from './ontos-client.ts';
import type { JsonObject } from './ontos-client.ts';
import { runWithPrincipal, withCompany } from './session.ts';
import type { PrincipalSession, WritePolicy } from './session.ts';
import { applyCommand } from './tools/shared.ts';

export const PLATFORM_APPROVALS_MODULE_ID = 'platform.approvals';
export const PLATFORM_APPROVALS_COMMAND = 'SubmitProposal';
export const AI_REVIEW_URL_CS: Readonly<Record<string, string>> = {
  'demo.crm': '/cs/crm/schvalovani-ai',
  'demo.sales-pipeline': '/cs/prodej/schvalovani-ai',
  'demo.merchandise': '/cs/prodej/schvalovani-ai',
};

const JsonObjectSchema = Schema.Record(Schema.String, Schema.Json);

export const toJsonObject = (value: unknown): JsonObject => {
  const decoded = Schema.decodeUnknownResult(JsonObjectSchema)(value ?? {});
  if (Result.isFailure(decoded)) {
    throw new Error('Vstup musí být JSON objekt.');
  }
  return decoded.success;
};

export const findEntry = (catalog: Catalog, idOrToolName: string): CatalogEntry | undefined => {
  for (const module of catalog.modules) {
    const entries: readonly CatalogEntry[] = [...module.reads, ...module.actions];
    const found = entries.find((entry) => entry.id === idOrToolName || entry.toolName === idOrToolName);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
};

export const findModule = (catalog: Catalog, moduleId: string): CatalogModule | undefined =>
  catalog.modules.find((module) => module.moduleId === moduleId);

export interface TruncatedPath {
  readonly path: string;
  readonly total: number;
  readonly offset: number;
  readonly returned: number;
}

const MAX_SHAPE_DEPTH = 3;

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Slices long arrays found as object properties (depth 1..3); returns a new value, never mutates the input. */
export const shapeReadResult = (
  value: unknown,
  options: { readonly limit: number; readonly offset: number },
): { readonly data: unknown; readonly truncated: readonly TruncatedPath[] } => {
  const truncated: TruncatedPath[] = [];

  const walk = (object: Readonly<Record<string, unknown>>, prefix: string, depth: number): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(object)) {
      const path = prefix === '' ? key : `${prefix}.${key}`;
      if (Array.isArray(child)) {
        if (child.length > options.limit || options.offset > 0) {
          const sliced = child.slice(options.offset, options.offset + options.limit);
          truncated.push({ offset: options.offset, path, returned: sliced.length, total: child.length });
          out[key] = sliced;
        } else {
          out[key] = child;
        }
      } else if (isPlainObject(child) && depth < MAX_SHAPE_DEPTH) {
        out[key] = walk(child, path, depth + 1);
      } else {
        out[key] = child;
      }
    }
    return out;
  };

  if (!isPlainObject(value)) {
    return { data: value, truncated };
  }
  return { data: walk(value, '', 1), truncated };
};

export interface ReadRequest {
  readonly id: string;
  readonly input?: JsonObject;
  readonly legalEntityId?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export const runRead = async (
  session: PrincipalSession,
  catalog: Catalog,
  request: ReadRequest,
): Promise<{
  readonly id: string;
  readonly legalEntityId: string | undefined;
  readonly data: unknown;
  readonly truncated: readonly TruncatedPath[];
}> => {
  const entry = findEntry(catalog, request.id);
  if (entry === undefined || entry.kind !== 'read') {
    throw new Error(`Neznámé čtení: ${request.id}. Seznam vrací ontos_list_capabilities.`);
  }
  const limit = Math.min(Math.max(request.limit ?? 50, 1), 500);
  const offset = Math.max(request.offset ?? 0, 0);
  const target = withCompany(session, request.legalEntityId ?? session.legalEntityId);
  const data = await runWithPrincipal(
    target,
    async () => await readRecords(entry.appId, entry.slug, request.input ?? {}, Schema.Json),
  );
  return { id: entry.id, legalEntityId: target.legalEntityId, ...shapeReadResult(data, { limit, offset }) };
};

export interface ExecuteRequest {
  readonly id: string;
  readonly input?: JsonObject;
  readonly legalEntityId?: string;
  readonly reason?: string;
  readonly idempotencyKey?: string;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const runExecute = async (
  session: PrincipalSession,
  catalog: Catalog,
  writePolicy: WritePolicy,
  request: ExecuteRequest,
): Promise<ExecuteOutcome> => {
  const entry = findEntry(catalog, request.id);
  if (entry === undefined || entry.kind !== 'action') {
    throw new Error(`Neznámá akce: ${request.id}. Seznam vrací ontos_list_capabilities.`);
  }
  const module = findModule(catalog, entry.moduleId);
  if (module === undefined) {
    throw new Error(`Modul ${entry.moduleId} není v katalogu.`);
  }
  const target = withCompany(session, request.legalEntityId ?? session.legalEntityId);

  // Current revision of a module: read through its probe read. Modules without one need input.expectedRevision.
  const revisionOf = (moduleId: string, appId: string, probeSlug: string | undefined) => async (): Promise<number> => {
    if (probeSlug !== undefined) {
      const body = await readRecords(appId, probeSlug, {}, Schema.Json);
      if (isRecord(body) && typeof body.revision === 'number') {
        return body.revision;
      }
    }
    throw new Error(
      `Modul ${moduleId} nemá jednu společnou revizi. Pošlete input.expectedRevision (najdete ji ve výsledku ontos_read u příslušné části).`,
    );
  };

  return await runWithPrincipal(target, async (): Promise<ExecuteOutcome> => {
    const key = request.idempotencyKey ?? randomUUID();
    const input: JsonObject = request.input ?? {};
    const { expectedRevision, ...fields } = input;
    const revision = typeof expectedRevision === 'number' ? expectedRevision : undefined;
    const command: JsonObject = entry.commandTag === undefined ? fields : { ...fields, _tag: entry.commandTag };

    if (writePolicy === 'direct') {
      if (entry.commandTag !== undefined) {
        const result = await applyCommand(
          entry.appId,
          Schema.Json,
          command,
          revisionOf(entry.moduleId, entry.appId, module.probeReadSlug),
          revision,
          key,
        );
        return { result, status: 'executed' };
      }
      const result = await callAction(entry.appId, entry.actionSlug, input, Schema.Json, key);
      return { result, status: 'executed' };
    }

    const reason = (request.reason ?? '').trim();
    const reasonText = reason.length < 3 ? `Změna navržená přes MCP: ${entry.commandTag ?? entry.actionSlug}` : reason;

    const platform = findModule(catalog, PLATFORM_APPROVALS_MODULE_ID);
    if (platform?.actions.some((action) => action.commandTag === PLATFORM_APPROVALS_COMMAND)) {
      // Contract proposed to lane approvals-platform on STATUS 09:20; adjust here if their API differs.
      const result = await applyCommand(
        platform.appId,
        Schema.Json,
        {
          _tag: PLATFORM_APPROVALS_COMMAND,
          actionSlug: entry.actionSlug,
          payload: entry.commandTag === undefined ? input : command,
          reason: reasonText,
          runId: key,
          summary: entry.id,
          targetAppId: entry.appId,
          targetModuleId: entry.moduleId,
        },
        revisionOf(platform.moduleId, platform.appId, platform.probeReadSlug),
        undefined,
        key,
      );
      return {
        messageCs: 'Návrh čeká na schválení v aplikaci. Data se zatím nezměnila.',
        result,
        status: 'proposed',
        via: 'platform-approvals',
      };
    }

    if (entry.commandTag !== undefined && entry.proposable && module.supportsAiProposals) {
      const result = await applyCommand(
        entry.appId,
        Schema.Json,
        {
          _tag: 'AiProposeChanges',
          changes: [{ operation: command, reason: reasonText }],
          instruction: reasonText,
          runId: key,
        },
        revisionOf(entry.moduleId, entry.appId, module.probeReadSlug),
        undefined,
        key,
      );
      return {
        messageCs: `Návrh uložen. Data se nezměnila; změnu schválí nebo zamítne člověk v aplikaci na ${AI_REVIEW_URL_CS[entry.moduleId] ?? 'stránce AI změn ke schválení'}.`,
        result,
        status: 'proposed',
        via: 'module-ai-proposals',
      };
    }

    throw new Error(
      `Tento účet smí zapisovat jen přes schválení a ${entry.id} nelze navrhnout ke schválení (modul tuto změnu jako návrh nepřijímá).`,
    );
  });
};
