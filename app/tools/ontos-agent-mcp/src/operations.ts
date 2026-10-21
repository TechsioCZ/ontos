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
  'demo.crm': '/cs/sprava/ke-schvaleni',
  'demo.sales-pipeline': '/cs/sprava/ke-schvaleni',
  'demo.merchandise': '/cs/sprava/ke-schvaleni',
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

/** A part of the read result left out to keep the answer small; fetch it with ontos_read {id, path}. */
export interface OmittedPath {
  readonly path: string;
  readonly kind: 'list' | 'object';
  /** List length or number of object keys in the original. */
  readonly count: number;
}

/** About 8-10k tokens of JSON: well below the MCP output caps of Claude (25k tokens) and ChatGPT. */
export const READ_CHAR_BUDGET = 24_000;
/** Lists inside list items (readings of a meter, lines of an order) keep at most this many entries. */
export const NESTED_LIST_LIMIT = 5;
const LONG_STRING = 400;
const MAX_WALK_DEPTH = 24;

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sizeOf = (value: unknown): number => JSON.stringify(value)?.length ?? 0;
const joinPath = (prefix: string, key: string): string => (prefix === '' ? key : `${prefix}.${key}`);

export class ReadPathError extends Error {
  override readonly name = 'ReadPathError';
}

/** Resolves `a.b[2].c` (or `a.b.2.c`) inside a read result. */
export const selectPath = (value: unknown, path: string): unknown => {
  const segments = path
    .replace(/\[(\d+)\]/gu, '.$1')
    .split('.')
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '');
  let current: unknown = value;
  let walked = '';
  for (const segment of segments) {
    if (Array.isArray(current) && /^\d+$/u.test(segment) && Number(segment) < current.length) {
      current = current[Number(segment)];
    } else if (isPlainObject(current) && Object.hasOwn(current, segment)) {
      current = current[segment];
    } else {
      const keys = isPlainObject(current)
        ? Object.keys(current).slice(0, 30).join(', ')
        : Array.isArray(current)
          ? `indexy 0–${Math.max(current.length - 1, 0)}`
          : 'žádné';
      throw new ReadPathError(
        `Cesta „${path}“ ve výsledku neexistuje (chybí „${segment}“${walked === '' ? '' : ` pod „${walked}“`}). Dostupné: ${keys}.`,
      );
    }
    walked = joinPath(walked, segment);
  }
  return current;
};

type Mutable = Record<string, unknown> | unknown[];
interface Slot {
  readonly parent: Mutable;
  readonly key: string | number;
  readonly path: string;
  readonly value: unknown;
}

/**
 * Keeps a read result small (design §5.3, critic: Provoz read was 390 KB):
 * 1. every list is cut to `limit` items starting at `offset`; lists inside list items keep NESTED_LIST_LIMIT items;
 * 2. while the JSON is over `budget` characters, the largest remaining list (then long text, then the largest object)
 *    is replaced by an `{_omitted, count, path}` marker; a list at the root is shortened from the end.
 * Returns a new value; the input is never mutated.
 */
export const shapeReadResult = (
  value: unknown,
  options: {
    readonly limit: number;
    readonly offset: number;
    readonly budget?: number;
    /** Where `value` sits in the full read result (ontos_read path); reported paths are prefixed with it. */
    readonly basePath?: string;
  },
): {
  readonly data: unknown;
  readonly truncated: readonly TruncatedPath[];
  readonly omitted: readonly OmittedPath[];
} => {
  const budget = options.budget ?? READ_CHAR_BUDGET;
  const base = options.basePath?.trim() ?? '';
  const display = (inner: string): string =>
    base === '' ? (inner === '' ? '(kořen)' : inner) : inner === '' ? base : inner.startsWith('[') ? `${base}${inner}` : `${base}.${inner}`;
  const truncated = new Map<string, TruncatedPath>();
  const omitted: OmittedPath[] = [];

  const slice = (node: unknown, path: string, insideList: boolean, depth: number): unknown => {
    if (depth > MAX_WALK_DEPTH) {
      return node;
    }
    if (Array.isArray(node)) {
      const offset = insideList ? 0 : options.offset;
      const limit = insideList ? Math.min(options.limit, NESTED_LIST_LIMIT) : options.limit;
      const kept = node.slice(offset, offset + limit);
      if (node.length > limit || offset > 0) {
        const pattern = insideList ? path.replace(/\[\d+\]/gu, '[]') : path;
        const previous = truncated.get(pattern);
        truncated.set(pattern, {
          offset,
          path: display(pattern),
          returned: kept.length,
          total: Math.max(node.length, previous?.total ?? 0),
        });
      }
      return kept.map((item, index) => slice(item, `${path}[${offset + index}]`, true, depth + 1));
    }
    if (isPlainObject(node)) {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) {
        out[key] = slice(child, joinPath(path, key), insideList, depth + 1);
      }
      return out;
    }
    return node;
  };

  const root = { value: slice(value, '', false, 0) };
  const slots = (predicate: (value: unknown) => boolean): Slot[] => {
    const found: Slot[] = [];
    // Paths use the indexes of the original result: lists outside list items start at `offset`.
    const visit = (node: unknown, path: string, insideList: boolean, depth: number): void => {
      if (depth > MAX_WALK_DEPTH) {
        return;
      }
      if (Array.isArray(node)) {
        const shift = insideList ? 0 : options.offset;
        node.forEach((item, index) => {
          const itemPath = `${path}[${index + shift}]`;
          if (predicate(item)) {
            found.push({ key: index, parent: node, path: itemPath, value: item });
          }
          visit(item, itemPath, true, depth + 1);
        });
      } else if (isPlainObject(node) && !Object.hasOwn(node, '_omitted')) {
        for (const [key, child] of Object.entries(node)) {
          const childPath = joinPath(path, key);
          if (predicate(child)) {
            found.push({ key, parent: node as Record<string, unknown>, path: childPath, value: child });
          }
          visit(child, childPath, insideList, depth + 1);
        }
      }
    };
    visit(root.value, '', false, 0);
    return found;
  };
  const setSlot = (slot: Slot, next: unknown): void => {
    if (Array.isArray(slot.parent)) {
      slot.parent[slot.key as number] = next;
    } else {
      slot.parent[slot.key as string] = next;
    }
  };
  const originalCount = (path: string, fallback: number): number => {
    try {
      const original = selectPath(value, path);
      return Array.isArray(original) ? original.length : isPlainObject(original) ? Object.keys(original).length : fallback;
    } catch {
      return fallback;
    }
  };
  const collapseLargest = (kind: 'list' | 'object'): boolean => {
    const candidates = slots((node) => (kind === 'list' ? Array.isArray(node) && node.length > 0 : isPlainObject(node) && !Object.hasOwn(node, '_omitted')))
      .map((slot) => ({ size: sizeOf(slot.value), slot }))
      .filter((candidate) => candidate.size > 200)
      .sort((left, right) => right.size - left.size);
    const [largest] = candidates;
    if (largest === undefined) {
      return false;
    }
    const { slot } = largest;
    const count = originalCount(
      slot.path,
      Array.isArray(slot.value) ? slot.value.length : Object.keys(slot.value as object).length,
    );
    const marker =
      kind === 'list'
        ? { _omitted: 'list', count, path: display(slot.path) }
        : { _omitted: 'object', count, keys: Object.keys(slot.value as object).slice(0, 15), path: display(slot.path) };
    setSlot(slot, marker);
    omitted.push({ count, kind, path: display(slot.path) });
    return true;
  };

  let guard = 0;
  while (sizeOf(root.value) > budget && guard < 400) {
    guard += 1;
    if (collapseLargest('list')) {
      continue;
    }
    const long = slots((node) => typeof node === 'string' && node.length > LONG_STRING);
    if (long.length > 0) {
      long.forEach((slot) => setSlot(slot, `${(slot.value as string).slice(0, LONG_STRING)}…`));
      continue;
    }
    if (collapseLargest('object')) {
      continue;
    }
    if (Array.isArray(root.value) && root.value.length > 1) {
      root.value.pop();
      truncated.set('', {
        offset: options.offset,
        path: display(''),
        returned: root.value.length,
        total: Array.isArray(value) ? value.length : root.value.length,
      });
      continue;
    }
    break;
  }
  const omittedPaths = new Set(omitted.map((item) => item.path));
  return { data: root.value, omitted, truncated: [...truncated.values()].filter((item) => !omittedPaths.has(item.path)) };
};

export interface ReadRequest {
  readonly id: string;
  readonly input?: JsonObject;
  readonly legalEntityId?: string;
  readonly limit?: number;
  readonly offset?: number;
  /** Part of the result to return, e.g. `agendas.assets.state.assets` (see OmittedPath). */
  readonly path?: string;
}

export const DEFAULT_READ_LIMIT = 25;

export const runRead = async (
  session: PrincipalSession,
  catalog: Catalog,
  request: ReadRequest,
): Promise<{
  readonly id: string;
  readonly legalEntityId: string | undefined;
  readonly path?: string;
  readonly data: unknown;
  readonly truncated: readonly TruncatedPath[];
  readonly omitted: readonly OmittedPath[];
}> => {
  const entry = findEntry(catalog, request.id);
  if (entry === undefined || entry.kind !== 'read') {
    throw new Error(`Neznámé čtení: ${request.id}. Seznam vrací ontos_capabilities.`);
  }
  const limit = Math.min(Math.max(request.limit ?? DEFAULT_READ_LIMIT, 1), 500);
  const offset = Math.max(request.offset ?? 0, 0);
  const target = withCompany(session, request.legalEntityId ?? session.legalEntityId);
  const data = await runWithPrincipal(
    target,
    async () => await readRecords(entry.appId, entry.slug, request.input ?? {}, Schema.Json),
  );
  const path = request.path?.trim() ?? '';
  const selected = path === '' ? data : selectPath(data, path);
  const shaped = shapeReadResult(selected, { basePath: path, limit, offset });
  return {
    data: shaped.data,
    id: entry.id,
    legalEntityId: target.legalEntityId,
    omitted: shaped.omitted,
    ...(path === '' ? {} : { path }),
    truncated: shaped.truncated,
  };
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
  if (writePolicy === 'read_only') {
    throw new Error('Toto připojení smí jen číst; změny nejsou povolené.');
  }
  const entry = findEntry(catalog, request.id);
  if (entry === undefined || entry.kind !== 'action') {
    throw new Error(`Neznámá akce: ${request.id}. Seznam vrací ontos_capabilities.`);
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
