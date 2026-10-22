/**
 * Derives the serialized MCP contribution (`manifest.publicSurface.mcp`) of one vertical from its authored
 * contribution and its own executable values: `/reads/<slug>` endpoints of its public HttpApis and its Action
 * registrations. JSON Schemas come from the vertical's Effect Schemas; repeated subtrees are shared through
 * `definitions` so large modules stay well inside the contract size limit.
 */
import { createHash } from 'node:crypto';

import { Predicate, Schema } from 'effect';
import { HttpApi } from 'effect/unstable/httpapi';

import { OntosMcpContributionSchema, OntosMcpHidden } from '../packages/core-runtime/src/modules/mcp-contribution.ts';
import type {
  OntosMcpContribution,
  OntosMcpContributionInput,
  OntosMcpTool,
  OntosMcpToolTextInput,
  OntosMcpWriteInput,
} from '../packages/core-runtime/src/modules/mcp-contribution.ts';

type Json = Schema.Json;
type JsonObject = { readonly [key: string]: Json };
type MutableJsonObject = { [key: string]: Json };

export class OntosMcpContributionDerivationError extends Error {
  override readonly name = 'OntosMcpContributionDerivationError';
}

const fail = (message: string): never => {
  throw new OntosMcpContributionDerivationError(message);
};

const isJsonObject = (value: unknown): value is JsonObject => Predicate.isObject(value) && !Array.isArray(value);

const snakeCase = (value: string): string =>
  value
    .replaceAll(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replaceAll(/[-.\s]+/gu, '_')
    .toLowerCase();

/** `<app_id>__<suffix>`; longer than 64 characters: first 55 + `_` + 8 hex of sha256(full name). */
export const mcpToolName = (appId: string, suffix: string): string => {
  const full = `${snakeCase(appId)}__${snakeCase(suffix)}`;
  return full.length <= 64
    ? full
    : `${full.slice(0, 55)}_${createHash('sha256').update(full).digest('hex').slice(0, 8)}`;
};

/** Default when the vertical does not say: verbs that remove, cancel or void data or access. */
const DESTRUCTIVE_VERB =
  /(delete|remove|cancel|storno|void|archive|revoke|deactivate|reject|terminate|dispose|retract|erase|erasure|anonymi|privacy|purge|wipe|reset|suspend)/iu;

interface SchemaDocument {
  readonly definitions: MutableJsonObject;
  readonly schema: JsonObject;
}

const documentOf = (schema: Schema.Top, label: string): SchemaDocument => {
  try {
    const document = Schema.toJsonSchemaDocument(schema);
    const { $schema: _dialect, ...root } = document.schema as MutableJsonObject;
    return { definitions: { ...(document.definitions as JsonObject) }, schema: root };
  } catch (error) {
    return fail(
      `${label}: the JSON Schema cannot be derived (${error instanceof Error ? error.message : String(error)})`,
    );
  }
};

const resolveRef = (node: Json | undefined, definitions: JsonObject): Json | undefined => {
  if (!isJsonObject(node) || typeof node['$ref'] !== 'string') {
    return node;
  }
  const name = node['$ref'].replace(/^#\/(?:\$defs|definitions)\//u, '');
  return definitions[name] ?? node;
};

interface TaggedVariant {
  readonly schema: JsonObject;
  readonly tag: string;
}

const variantTag = (node: JsonObject): string | undefined => {
  const properties = node['properties'];
  if (!isJsonObject(properties) || !isJsonObject(properties['_tag'])) {
    return undefined;
  }
  const tag = properties['_tag'];
  const values = tag['enum'];
  if (Array.isArray(values) && values.length === 1 && typeof values[0] === 'string') {
    return values[0];
  }
  return typeof tag['const'] === 'string' ? tag['const'] : undefined;
};

/** Every object with a single `_tag` literal, depth-first through anyOf/oneOf/$ref, in source order. */
const taggedVariants = (node: Json | undefined, definitions: JsonObject): TaggedVariant[] => {
  const resolved = resolveRef(node, definitions);
  if (!isJsonObject(resolved)) {
    return [];
  }
  const tag = variantTag(resolved);
  if (tag !== undefined) {
    return [{ schema: resolved, tag }];
  }
  return [resolved['anyOf'], resolved['oneOf']].flatMap((branches) =>
    Array.isArray(branches) ? branches.flatMap((branch) => taggedVariants(branch, definitions)) : [],
  );
};

/** Command arguments: the variant's fields without `_tag`, plus an optional integer `expectedRevision`. */
const commandInputSchema = (variant: JsonObject): JsonObject => {
  const sourceProperties = isJsonObject(variant['properties']) ? variant['properties'] : {};
  const { _tag: _omitted, ...properties } = sourceProperties;
  const required = Array.isArray(variant['required'])
    ? variant['required'].filter((name): name is string => typeof name === 'string' && name !== '_tag')
    : [];
  return {
    additionalProperties: variant['additionalProperties'] ?? false,
    properties: {
      ...properties,
      expectedRevision: {
        description: 'Revize pro kontrolu souběžných změn; když chybí, OntOS ji načte sám. / Optional revision.',
        minimum: 0,
        type: 'integer',
      },
    },
    required,
    type: 'object',
  };
};

interface ReadEndpoint {
  readonly document: SchemaDocument;
  readonly path: string;
  readonly slug: string;
}

const READ_PATH = /^\/reads\/([a-z0-9-]+)$/u;

const readEndpointsOf = (api: Readonly<Record<string, unknown>>): ReadEndpoint[] => {
  const reads = new Map<string, ReadEndpoint>();
  for (const [apiKey, value] of Object.entries(api)) {
    if (!HttpApi.isHttpApi(value)) {
      continue;
    }
    HttpApi.reflect(value, {
      onEndpoint: ({ endpoint }) => {
        const slug = READ_PATH.exec(endpoint.path)?.[1];
        const schema = endpoint.payload.get('application/json')?.schemas[0];
        if (slug === undefined || schema === undefined || reads.has(slug)) {
          return;
        }
        reads.set(slug, { document: documentOf(schema, `${apiKey} ${endpoint.path}`), path: endpoint.path, slug });
      },
      onGroup: () => undefined,
    });
  }
  return [...reads.values()].sort((left, right) => left.slug.localeCompare(right.slug));
};

interface ActionValue {
  readonly descriptor: { readonly actionKey: string; readonly payloadSchema?: unknown };
}

const isActionValue = (value: unknown): value is ActionValue =>
  Predicate.isObject(value) &&
  Predicate.isObject(Reflect.get(value, 'descriptor')) &&
  Predicate.isString(Reflect.get(Reflect.get(value, 'descriptor') as object, 'actionKey'));

interface ActionEndpoint {
  readonly document: SchemaDocument;
  readonly path: string;
  readonly slug: string;
  /** Present for command-union Actions (`{ command, expectedRevision }`). */
  readonly variants: readonly TaggedVariant[] | undefined;
}

const actionEndpointsOf = (actions: readonly unknown[], moduleId: string, appId: string): ActionEndpoint[] =>
  actions
    .map((action): ActionEndpoint => {
      if (!isActionValue(action)) {
        return fail('manifest Actions must be Action registrations');
      }
      const { actionKey, payloadSchema } = action.descriptor;
      const slug = actionKey.startsWith(`${moduleId}.`) ? actionKey.slice(moduleId.length + 1) : actionKey;
      if (!Schema.isSchema(payloadSchema)) {
        return fail(`Action ${actionKey} has no payload Schema`);
      }
      const document = documentOf(payloadSchema, `Action ${actionKey}`);
      const root = resolveRef(document.schema, document.definitions);
      const properties = isJsonObject(root) && isJsonObject(root['properties']) ? root['properties'] : {};
      const variants =
        'command' in properties && 'expectedRevision' in properties
          ? taggedVariants(properties['command'], document.definitions)
          : [];
      return {
        document,
        path: `/${appId}/actions/${slug}`,
        slug,
        variants: variants.length > 0 ? variants : undefined,
      };
    })
    .sort((left, right) => left.slug.localeCompare(right.slug));

/** Moves repeated subtrees (>= 300 characters, used at least twice) into shared definitions. */
const shareRepeatedSubtrees = (
  tools: readonly { readonly schema: JsonObject }[],
  definitions: MutableJsonObject,
): JsonObject[] => {
  const counts = new Map<string, number>();
  const count = (node: Json): void => {
    if (node !== null && typeof node === 'object') {
      const text = JSON.stringify(node);
      if (text.length >= 300) {
        counts.set(text, (counts.get(text) ?? 0) + 1);
      }
      for (const child of Object.values(node)) {
        count(child);
      }
    }
  };
  for (const tool of tools) {
    count(tool.schema);
  }
  for (const value of Object.values(definitions)) {
    count(value);
  }
  const keys = new Map<string, string>();
  const share = (node: Json, isRoot: boolean): Json => {
    if (node === null || typeof node !== 'object') {
      return node;
    }
    const text = JSON.stringify(node);
    if (!isRoot && text.length >= 300 && (counts.get(text) ?? 0) > 1) {
      let key = keys.get(text);
      if (key === undefined) {
        key = `S${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
        keys.set(text, key);
        definitions[key] = share(node, true);
      }
      return { $ref: `#/$defs/${key}` };
    }
    return Array.isArray(node)
      ? node.map((child) => share(child, false))
      : Object.fromEntries(Object.entries(node).map(([name, child]) => [name, share(child, false)]));
  };
  for (const [name, value] of Object.entries(definitions)) {
    if (!name.startsWith('S')) {
      definitions[name] = share(value, true);
    }
  }
  return tools.map((tool) => share(tool.schema, true) as JsonObject);
};

const mergeDefinitions = (target: MutableJsonObject, source: JsonObject, label: string): void => {
  for (const [name, value] of Object.entries(source)) {
    if (name in target && JSON.stringify(target[name]) !== JSON.stringify(value)) {
      fail(`${label}: JSON Schema definition ${name} differs between two schemas of the module`);
    }
    target[name] = value;
  }
};

const checkCoverage = (
  group: string,
  declared: Readonly<Record<string, unknown>>,
  available: ReadonlySet<string>,
  moduleId: string,
): void => {
  const missing = [...available].filter((key) => !(key in declared)).sort();
  if (missing.length > 0) {
    fail(`${moduleId}: MCP ${group} not contributed or hidden: ${missing.join(', ')}`);
  }
  const unknown = Object.keys(declared)
    .filter((key) => !available.has(key))
    .sort();
  if (unknown.length > 0) {
    fail(`${moduleId}: MCP ${group} do not exist in the module: ${unknown.join(', ')}`);
  }
};

const textFields = (entry: OntosMcpToolTextInput) => ({
  title: entry.title,
  ...(entry.description === undefined ? {} : { description: entry.description }),
});

const writeFields = (entry: OntosMcpWriteInput, verb: string) => ({
  ...textFields(entry),
  agentProposalOnly: entry.agentProposalOnly ?? false,
  destructive: entry.destructive ?? DESTRUCTIVE_VERB.test(verb),
  referenceAudiences: [...(entry.referenceAudiences ?? [])],
  ...(entry.liveRight === undefined ? {} : { liveRight: entry.liveRight }),
});

export interface DeriveOntosMcpContributionInput {
  readonly actions: readonly unknown[];
  readonly api: Readonly<Record<string, unknown>>;
  readonly appId: string;
  readonly authored: OntosMcpContributionInput | undefined;
  readonly moduleId: string;
}

/** Undefined when the vertical contributes no MCP tools. */
export const deriveOntosMcpContribution = (
  input: DeriveOntosMcpContributionInput,
): OntosMcpContribution | undefined => {
  const { appId, authored, moduleId } = input;
  if (authored === undefined) {
    return undefined;
  }
  const reads = readEndpointsOf(input.api);
  const actions = actionEndpointsOf(input.actions, moduleId, appId);
  const commandActions = actions.filter((action) => action.variants !== undefined);
  const namedActions = actions.filter((action) => action.variants === undefined);
  checkCoverage('reads', authored.reads, new Set(reads.map((read) => read.slug)), moduleId);
  checkCoverage(
    'commands',
    authored.commands ?? {},
    new Set(commandActions.flatMap((action) => (action.variants ?? []).map((variant) => variant.tag))),
    moduleId,
  );
  checkCoverage('actions', authored.actions ?? {}, new Set(namedActions.map((action) => action.slug)), moduleId);

  const definitions: MutableJsonObject = {};
  const drafts: { readonly schema: JsonObject; readonly tool: Omit<OntosMcpTool, 'inputSchema'> }[] = [];
  for (const read of reads) {
    const entry = authored.reads[read.slug];
    if (entry === undefined || entry === OntosMcpHidden) {
      continue;
    }
    mergeDefinitions(definitions, read.document.definitions, `${moduleId} read ${read.slug}`);
    drafts.push({
      schema: read.document.schema,
      tool: {
        access: 'read',
        agentProposalOnly: false,
        destructive: false,
        id: `${moduleId}/read/${read.slug}`,
        invoke: { path: read.path },
        name: mcpToolName(appId, `read_${read.slug}`),
        referenceAudiences: [],
        ...textFields(entry),
      },
    });
  }
  for (const action of commandActions) {
    for (const variant of action.variants ?? []) {
      const entry = authored.commands?.[variant.tag];
      if (entry === undefined || entry === OntosMcpHidden) {
        continue;
      }
      mergeDefinitions(definitions, action.document.definitions, `${moduleId} command ${variant.tag}`);
      drafts.push({
        schema: commandInputSchema(variant.schema),
        tool: {
          access: 'write',
          id: `${moduleId}/command/${variant.tag}`,
          invoke: { commandTag: variant.tag, path: action.path },
          name: mcpToolName(appId, variant.tag),
          ...writeFields(entry, variant.tag),
        },
      });
    }
  }
  for (const action of namedActions) {
    const entry = authored.actions?.[action.slug];
    if (entry === undefined || entry === OntosMcpHidden) {
      continue;
    }
    mergeDefinitions(definitions, action.document.definitions, `${moduleId} action ${action.slug}`);
    drafts.push({
      schema: action.document.schema,
      tool: {
        access: 'write',
        id: `${moduleId}/action/${action.slug}`,
        invoke: { path: action.path },
        name: mcpToolName(appId, action.slug),
        ...writeFields(entry, action.slug),
      },
    });
  }
  for (const key of ['id', 'name'] as const) {
    const seen = new Set<string>();
    for (const { tool } of drafts) {
      if (seen.has(tool[key])) {
        fail(`${moduleId}: duplicate MCP tool ${key} ${tool[key]}`);
      }
      seen.add(tool[key]);
    }
  }
  const schemas = shareRepeatedSubtrees(drafts, definitions);
  const revision = authored.revision;
  const contribution = {
    ...(authored.approvalReview === undefined
      ? {}
      : {
          approvalReview: {
            path: `/reads/${authored.approvalReview.read}`,
            privateRecords: authored.approvalReview.privateRecords === true,
          },
        }),
    approvals: authored.approvals,
    ...(authored.approvalsPage === undefined
      ? {}
      : {
          approvalsPage: {
            label: { cs: authored.approvalsPage.label.cs, en: authored.approvalsPage.label.en },
            path: authored.approvalsPage.path,
          },
        }),
    ...(authored.commandFieldLabels === undefined
      ? {}
      : { commandFieldLabels: { ...authored.commandFieldLabels } }),
    definitions,
    description: authored.description,
    keywords: authored.keywords,
    label: authored.label,
    ...(authored.legalEntityWriteRelations === undefined
      ? {}
      : { legalEntityWriteRelations: [...authored.legalEntityWriteRelations] }),
    ...(authored.ownProposalEngine === true ? { ownProposalEngine: true } : {}),
    ...(authored.page === undefined ? {} : { page: authored.page }),
    ...(revision === undefined
      ? {}
      : {
          revision: {
            field: revision.field ?? 'revision',
            fieldsByCommandPrefix: (revision.fieldsByCommandPrefix ?? []).map(({ field, prefix }) => ({
              field,
              prefix,
            })),
            path: `/reads/${revision.read}`,
            query: { ...(revision.query ?? {}) },
          },
        }),
    tools: drafts.map(({ tool }, index) => ({ ...tool, inputSchema: schemas[index] ?? {} })),
  };
  return Schema.decodeUnknownSync(OntosMcpContributionSchema, { onExcessProperty: 'error' })(contribution);
};
