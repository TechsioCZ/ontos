/**
 * Derives the serialized MCP contribution (`manifest.publicSurface.mcp`) of one vertical from its authored
 * contribution and its own executable values: `/reads/<slug>` endpoints of its public HttpApis and its Action
 * registrations. The tools go to a separate tool catalog artifact the contribution pins by digest; JSON Schemas
 * come from the vertical's Effect Schemas, and repeated subtrees are shared through `definitions`.
 */
import { createHash } from 'node:crypto';

import { Array as EffectArray, Order, Predicate, Result, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { HttpApi } from 'effect/http-api';

import {
  ONTOS_MODULE_MCP_TOOL_CATALOG_PATH,
  OntosMcpContributionSchema,
  OntosMcpHidden,
  OntosMcpToolCatalogJsonSchema,
} from '../packages/core-runtime/src/modules/mcp-contribution.ts';
import type {
  OntosMcpContribution,
  OntosMcpContributionInput,
  OntosMcpTool,
  OntosMcpToolTextInput,
  OntosMcpWriteInput,
} from '../packages/core-runtime/src/modules/mcp-contribution.ts';

type Json = Schema.Json;
type JsonObject = typeof Schema.JsonObject.Type;
type MutableJsonObject = Record<string, Json>;

export class OntosMcpContributionDerivationError extends Schema.TaggedError<OntosMcpContributionDerivationError>()(
  'OntosMcpContributionDerivationError',
  { message: Schema.String },
) {
  override readonly name = 'OntosMcpContributionDerivationError';
}

type DerivationFailure = OntosMcpContributionDerivationError | Schema.SchemaError;

const fail = (message: string) => Result.fail(new OntosMcpContributionDerivationError({ message }));
type Mutable<Value> = { -readonly [Key in keyof Value]: Value[Key] };
const isJsonObject = Schema.is(Schema.JsonObject);
const isJsonArray = EffectArray.isArray<Json | undefined>;
const isString = Schema.is(Schema.String);
const encodeJson = Schema.encodeResult(Schema.fromJsonString(Schema.Json));

const snakeCase = (value: string): string =>
  value
    .replaceAll(/(?<lower>[a-z0-9])(?<upper>[A-Z])/gu, '$<lower>_$<upper>')
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
  /(?:delete|remove|cancel|storno|void|archive|revoke|deactivate|reject|terminate|dispose|retract|erase|erasure|anonymi|privacy|purge|wipe|reset|suspend)/iu;

interface SchemaDocument {
  readonly definitions: MutableJsonObject;
  readonly schema: JsonObject;
}

const SchemaDocumentSchema = Schema.Struct({ definitions: Schema.JsonObject, schema: Schema.JsonObject });

const documentOf = (
  schema: Schema.Top,
  label: string,
): Result.Result<SchemaDocument, OntosMcpContributionDerivationError> =>
  Result.gen(function* deriveDocument() {
    const document = yield* Result.try({
      catch: (cause) =>
        new OntosMcpContributionDerivationError({
          message: `${label}: the JSON Schema cannot be derived (${Predicate.isError(cause) ? cause.message : String(cause)})`,
        }),
      try: () => Schema.toJsonSchemaDocument(schema),
    });
    const decoded = yield* Schema.decodeUnknownResult(SchemaDocumentSchema)(document).pipe(
      Result.mapError(
        (cause) =>
          new OntosMcpContributionDerivationError({
            message: `${label}: the JSON Schema cannot be derived (${cause.message})`,
          }),
      ),
    );
    const { $schema: _dialect, ...root } = decoded.schema;
    return { definitions: { ...decoded.definitions }, schema: root };
  });

const resolveRef = (node: Json | undefined, definitions: JsonObject): Json | undefined => {
  if (!isJsonObject(node) || !isString(node.$ref)) {
    return node;
  }
  const name = node.$ref.replace(/^#\/(?:\$defs|definitions)\//u, '');
  return definitions[name] ?? node;
};

interface TaggedVariant {
  readonly schema: JsonObject;
  readonly tag: string;
}

const variantTag = (node: JsonObject): string | undefined => {
  const { properties } = node;
  if (!isJsonObject(properties) || !isJsonObject(properties._tag)) {
    return undefined;
  }
  const tag = properties._tag;
  const values = tag.enum;
  if (isJsonArray(values) && values.length === 1 && isString(values[0])) {
    return values[0];
  }
  return isString(tag.const) ? tag.const : undefined;
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
  return [resolved.anyOf, resolved.oneOf].flatMap((branches) =>
    isJsonArray(branches) ? branches.flatMap((branch) => taggedVariants(branch, definitions)) : [],
  );
};

/** Command arguments: the variant's fields without `_tag`, plus an optional integer `expectedRevision`. */
const commandInputSchema = (variant: JsonObject) => {
  const sourceProperties = isJsonObject(variant.properties) ? variant.properties : {};
  const { _tag: _omitted, ...properties } = sourceProperties;
  const required = isJsonArray(variant.required)
    ? variant.required.filter((name) => isString(name) && name !== '_tag')
    : [];
  return {
    additionalProperties: variant.additionalProperties ?? false,
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
  } satisfies JsonObject;
};

interface ReadEndpoint {
  readonly document: SchemaDocument;
  readonly path: string;
  readonly slug: string;
}

const READ_PATH = /^\/reads\/(?<slug>[a-z0-9-]+)$/u;
const compareSlugs = (left: Pick<ReadEndpoint, 'slug'>, right: Pick<ReadEndpoint, 'slug'>) =>
  Order.Number(left.slug.localeCompare(right.slug), 0);

const readEndpointsOf = (
  api: DeriveOntosMcpContributionInput['api'],
): Result.Result<ReadEndpoint[], OntosMcpContributionDerivationError> => {
  const reads = new Map<string, Result.Result<ReadEndpoint, OntosMcpContributionDerivationError>>();
  for (const [apiKey, value] of Object.entries(api)) {
    if (!HttpApi.isHttpApi(value)) {
      continue;
    }
    HttpApi.reflect(value, {
      onEndpoint: ({ endpoint }) => {
        const slug = READ_PATH.exec(endpoint.path)?.groups?.slug;
        const schema = endpoint.payload.get('application/json')?.schemas[0];
        if (slug === undefined || schema === undefined || reads.has(slug)) {
          return;
        }
        reads.set(
          slug,
          documentOf(schema, `${apiKey} ${endpoint.path}`).pipe(
            Result.map((document) => ({ document, path: endpoint.path, slug })),
          ),
        );
      },
      onGroup: constVoid,
    });
  }
  return Result.all(reads.values()).pipe(Result.map((endpoints) => EffectArray.sort(endpoints, compareSlugs)));
};

const ActionValueSchema = Schema.Struct({
  descriptor: Schema.Struct({
    actionKey: Schema.String.pipe(Schema.brand('McpActionKey')),
    payloadSchema: Schema.optionalKey(Schema.Unknown),
  }),
});

interface ActionEndpoint {
  readonly document: SchemaDocument;
  readonly path: string;
  readonly slug: string;
  /** Present for command-union Actions (`{ command, expectedRevision }`). */
  readonly variants: readonly TaggedVariant[] | undefined;
}

const actionEndpointsOf = (
  actions: DeriveOntosMcpContributionInput['actions'],
  moduleId: string,
  appId: string,
): Result.Result<ActionEndpoint[], OntosMcpContributionDerivationError> =>
  Result.all(
    actions.map((action) =>
      Result.gen(function* deriveActionEndpoint() {
        const { descriptor } = yield* Schema.decodeUnknownResult(ActionValueSchema)(action).pipe(
          Result.mapError(
            () =>
              new OntosMcpContributionDerivationError({
                message: 'manifest Actions must be Action registrations',
              }),
          ),
        );
        const { actionKey, payloadSchema } = descriptor;
        const slug = actionKey.startsWith(`${moduleId}.`) ? actionKey.slice(moduleId.length + 1) : actionKey;
        if (!Schema.isSchema(payloadSchema)) {
          return yield* fail(`Action ${actionKey} has no payload Schema`);
        }
        const document = yield* documentOf(payloadSchema, `Action ${actionKey}`);
        const root = resolveRef(document.schema, document.definitions);
        const properties = isJsonObject(root) && isJsonObject(root.properties) ? root.properties : {};
        const variants =
          'command' in properties && 'expectedRevision' in properties
            ? taggedVariants(properties.command, document.definitions)
            : [];
        return {
          document,
          path: `/${appId}/actions/${slug}`,
          slug,
          variants: variants.length > 0 ? variants : undefined,
        } satisfies ActionEndpoint;
      }),
    ),
  ).pipe(Result.map((endpoints) => EffectArray.sort(endpoints, compareSlugs)));

const SCHEMA_MAP_KEYWORDS = new Set([
  '$defs',
  'definitions',
  'properties',
  'patternProperties',
  'dependentSchemas',
  'dependencies',
]);
const SCHEMA_ARRAY_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems', 'items']);
const SCHEMA_CHILD_KEYWORDS = new Set([
  'additionalItems',
  'additionalProperties',
  'unevaluatedItems',
  'unevaluatedProperties',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
  'contentSchema',
]);

const mapSchemaEntry = <E,>([name, child]: readonly [string, Json], visit: (schema: Json) => Result.Result<Json, E>) =>
  visit(child).pipe(Result.map((mapped) => [name, mapped] as const));

/** Visit schema positions only: property maps, schema arrays and literal/annotation data are not schemas. */
const mapSchemaChildren = <E,>(
  schema: JsonObject,
  visit: (schema: Json) => Result.Result<Json, E>,
): Result.Result<JsonObject, E> =>
  Result.all(
    Object.entries(schema).map(([keyword, value]) =>
      Result.gen(function* mapSchemaKeyword() {
        let child = value;
        if (SCHEMA_MAP_KEYWORDS.has(keyword) && isJsonObject(value)) {
          const entries = yield* Result.all(Object.entries(value).map((entry) => mapSchemaEntry(entry, visit)));
          child = Object.fromEntries(entries);
        } else if (SCHEMA_ARRAY_KEYWORDS.has(keyword)) {
          child = yield* isJsonArray(value) ? Result.all(value.map(visit)) : visit(value);
        } else if (SCHEMA_CHILD_KEYWORDS.has(keyword)) {
          child = yield* visit(value);
        }
        return [keyword, child] as const;
      }),
    ),
  ).pipe(Result.map((entries) => Object.fromEntries(entries)));

interface SharedSubtreeState {
  readonly counts: ReadonlyMap<string, number>;
  readonly definitions: MutableJsonObject;
  readonly keys: Map<string, string>;
}

const shareSchemaSubtree = (
  node: Json,
  isRoot: boolean,
  state: SharedSubtreeState,
): Result.Result<Json, Schema.SchemaError> =>
  Result.gen(function* shareSubtree() {
    if (!isJsonObject(node)) {
      return node;
    }
    const { counts, definitions, keys } = state;
    const text = yield* encodeJson(node);
    if (!isRoot && text.length >= 300 && (counts.get(text) ?? 0) > 1) {
      let key = keys.get(text);
      if (key === undefined) {
        const base = `S${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
        key = base;
        let suffix = 2;
        while (key in definitions) {
          key = `${base}_${suffix}`;
          suffix += 1;
        }
        keys.set(text, key);
        definitions[key] = yield* shareSchemaSubtree(node, true, state);
      }
      return { $ref: `#/$defs/${key}` };
    }
    return yield* mapSchemaChildren(node, (child) => shareSchemaSubtree(child, false, state));
  });

/** Moves repeated schemas (>= 300 characters, used at least twice) into shared definitions. */
const shareRepeatedSubtrees = (
  tools: readonly { readonly schema: JsonObject }[],
  definitions: MutableJsonObject,
): Result.Result<JsonObject[], Schema.SchemaError> =>
  Result.gen(function* shareSubtrees() {
    const counts = new Map<string, number>();
    const count = (node: Json): Result.Result<Json, Schema.SchemaError> =>
      Result.gen(function* countSubtree() {
        if (isJsonObject(node)) {
          const text = yield* encodeJson(node);
          if (text.length >= 300) {
            counts.set(text, (counts.get(text) ?? 0) + 1);
          }
          yield* mapSchemaChildren(node, count);
        }
        return node;
      });
    for (const tool of tools) {
      yield* count(tool.schema);
    }
    for (const value of Object.values(definitions)) {
      yield* count(value);
    }
    const state: SharedSubtreeState = { counts, definitions, keys: new Map() };
    const shareChild = (child: Json) => shareSchemaSubtree(child, false, state);
    // Snapshot authored definitions before sharing adds generated ones; an authored name can start with S too.
    for (const [name, value] of Object.entries(definitions)) {
      definitions[name] = yield* shareSchemaSubtree(value, true, state);
    }
    return yield* Result.all(tools.map((tool) => mapSchemaChildren(tool.schema, shareChild)));
  });

const mergeDefinitions = (
  target: MutableJsonObject,
  source: JsonObject,
  label: string,
): Result.Result<void, DerivationFailure> =>
  Result.gen(function* mergeSchemaDefinitions() {
    for (const [name, value] of Object.entries(source)) {
      const previous = target[name];
      if (name in target && previous !== undefined) {
        // Definition identity is byte-order-sensitive, just like the catalog and subtree digest inputs.
        const previousText = yield* encodeJson(previous);
        const nextText = yield* encodeJson(value);
        if (previousText !== nextText) {
          yield* fail(`${label}: JSON Schema definition ${name} differs between two schemas of the module`);
        }
      }
      target[name] = value;
    }
  });

const checkCoverage = (
  group: string,
  declared: Readonly<Record<string, OntosMcpToolTextInput | typeof OntosMcpHidden>>,
  available: ReadonlySet<string>,
  moduleId: string,
): Result.Result<void, OntosMcpContributionDerivationError> => {
  const missing = EffectArray.sort(
    [...available].filter((key) => !(key in declared)),
    Order.String,
  );
  if (missing.length > 0) {
    return fail(`${moduleId}: MCP ${group} not contributed or hidden: ${missing.join(', ')}`);
  }
  const unknown = EffectArray.sort(
    Object.keys(declared).filter((key) => !available.has(key)),
    Order.String,
  );
  if (unknown.length > 0) {
    return fail(`${moduleId}: MCP ${group} do not exist in the module: ${unknown.join(', ')}`);
  }
  return Result.void;
};

const textFields = (entry: OntosMcpToolTextInput) => {
  const fields: Mutable<Pick<OntosMcpTool, 'title' | 'description'>> = { title: entry.title };
  if (entry.description !== undefined) {
    fields.description = entry.description;
  }
  return fields;
};

const writeFields = (entry: OntosMcpWriteInput, verb: string) => {
  const fields: Mutable<
    Pick<
      OntosMcpTool,
      'title' | 'description' | 'agentProposalOnly' | 'destructive' | 'referenceAudiences' | 'liveRight'
    >
  > = {
    ...textFields(entry),
    agentProposalOnly: entry.agentProposalOnly ?? false,
    destructive: entry.destructive ?? DESTRUCTIVE_VERB.test(verb),
    referenceAudiences: [...(entry.referenceAudiences ?? [])],
  };
  if (entry.liveRight !== undefined) {
    fields.liveRight = entry.liveRight;
  }
  return fields;
};

export interface DeriveOntosMcpContributionInput {
  readonly actions: readonly unknown[];
  readonly api: Readonly<Record<string, HttpApi.Constraint>>;
  readonly appId: string;
  readonly authored: OntosMcpContributionInput | undefined;
  readonly moduleId: string;
}

export interface DerivedOntosMcpContribution {
  /** `manifest.publicSurface.mcp` of the deployment contract. */
  readonly contribution: OntosMcpContribution;
  /** Exact text of the tool catalog artifact the contribution pins (served at its `toolCatalog.path`). */
  readonly toolCatalog: string;
}

interface ToolDraft {
  readonly schema: JsonObject;
  readonly tool: Omit<OntosMcpTool, 'inputSchema'>;
}

const collectDrafts = (
  authored: OntosMcpContributionInput,
  reads: readonly ReadEndpoint[],
  commandActions: readonly ActionEndpoint[],
  namedActions: readonly ActionEndpoint[],
  definitions: MutableJsonObject,
  appId: string,
  moduleId: string,
): Result.Result<ToolDraft[], DerivationFailure> =>
  Result.gen(function* collectToolDrafts() {
    const drafts: ToolDraft[] = [];
    for (const read of reads) {
      const entry = authored.reads[read.slug];
      if (entry === undefined || entry === OntosMcpHidden) {
        continue;
      }
      yield* mergeDefinitions(definitions, read.document.definitions, `${moduleId} read ${read.slug}`);
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
        yield* mergeDefinitions(definitions, action.document.definitions, `${moduleId} command ${variant.tag}`);
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
      yield* mergeDefinitions(definitions, action.document.definitions, `${moduleId} action ${action.slug}`);
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
    return drafts;
  });

const checkUniqueTools = (
  drafts: readonly ToolDraft[],
  moduleId: string,
): Result.Result<void, OntosMcpContributionDerivationError> => {
  for (const key of ['id', 'name'] as const) {
    const seen = new Set<string>();
    for (const { tool } of drafts) {
      if (seen.has(tool[key])) {
        return fail(`${moduleId}: duplicate MCP tool ${key} ${tool[key]}`);
      }
      seen.add(tool[key]);
    }
  }
  return Result.void;
};

const contributionOf = (authored: OntosMcpContributionInput, toolCatalog: string, toolCount: number) => {
  const { revision } = authored;
  const contribution: Mutable<OntosMcpContribution> = {
    approvals: authored.approvals,
    description: authored.description,
    keywords: authored.keywords,
    label: authored.label,
    toolCatalog: {
      path: ONTOS_MODULE_MCP_TOOL_CATALOG_PATH,
      sha256: createHash('sha256').update(toolCatalog).digest('hex'),
      toolCount,
    },
  };
  if (authored.approvalReview !== undefined) {
    contribution.approvalReview = {
      path: `/reads/${authored.approvalReview.read}`,
      privateRecords: authored.approvalReview.privateRecords === true,
    };
  }
  if (authored.agentAdministrationPage !== undefined) {
    contribution.agentAdministrationPage = authored.agentAdministrationPage;
  }
  if (authored.approvalsPage !== undefined) {
    contribution.approvalsPage = {
      label: { cs: authored.approvalsPage.label.cs, en: authored.approvalsPage.label.en },
      path: authored.approvalsPage.path,
    };
  }
  if (authored.commandFieldLabels !== undefined) {
    contribution.commandFieldLabels = { ...authored.commandFieldLabels };
  }
  if (authored.legalEntityWriteRelations !== undefined) {
    contribution.legalEntityWriteRelations = [...authored.legalEntityWriteRelations];
  }
  if (authored.ownProposalEngine === true) {
    contribution.ownProposalEngine = true;
  }
  if (authored.page !== undefined) {
    contribution.page = authored.page;
  }
  if (authored.recordLinks !== undefined) {
    contribution.recordLinks = authored.recordLinks;
  }
  if (revision !== undefined) {
    contribution.revision = {
      field: revision.field ?? 'revision',
      fieldsByCommandPrefix: (revision.fieldsByCommandPrefix ?? []).map(({ field, prefix }) => ({ field, prefix })),
      path: `/reads/${revision.read}`,
      query: { ...revision.query },
    };
  }
  return contribution;
};

const deriveContributionResult = (
  input: DeriveOntosMcpContributionInput,
): Result.Result<DerivedOntosMcpContribution | undefined, DerivationFailure> =>
  Result.gen(function* deriveContribution() {
    const { appId, authored, moduleId } = input;
    if (authored === undefined) {
      return authored;
    }
    const reads = yield* readEndpointsOf(input.api);
    const actions = yield* actionEndpointsOf(input.actions, moduleId, appId);
    const commandActions = actions.filter((action) => action.variants !== undefined);
    const namedActions = actions.filter((action) => action.variants === undefined);
    yield* checkCoverage('reads', authored.reads, new Set(reads.map((read) => read.slug)), moduleId);
    yield* checkCoverage(
      'commands',
      authored.commands ?? {},
      new Set(commandActions.flatMap((action) => (action.variants ?? []).map((variant) => variant.tag))),
      moduleId,
    );
    yield* checkCoverage(
      'actions',
      authored.actions ?? {},
      new Set(namedActions.map((action) => action.slug)),
      moduleId,
    );
    const definitions: MutableJsonObject = {};
    const drafts = yield* collectDrafts(authored, reads, commandActions, namedActions, definitions, appId, moduleId);
    yield* checkUniqueTools(drafts, moduleId);
    const schemas = yield* shareRepeatedSubtrees(drafts, definitions);
    const toolCatalog = yield* Schema.encodeResult(OntosMcpToolCatalogJsonSchema)({
      definitions,
      tools: drafts.map(({ tool }, index) => ({ ...tool, inputSchema: schemas[index] ?? {} })),
    });
    const contribution = yield* Schema.decodeUnknownResult(OntosMcpContributionSchema, { onExcessProperty: 'error' })(
      contributionOf(authored, toolCatalog, drafts.length),
    );
    return {
      contribution,
      toolCatalog,
    };
  });

/** Undefined when the vertical contributes no MCP tools. */
export const deriveOntosMcpContribution = (
  input: DeriveOntosMcpContributionInput,
): DerivedOntosMcpContribution | undefined =>
  // The generator's synchronous adapter expects exceptions; retain typed failures until that boundary.
  Result.getOrThrow(deriveContributionResult(input));
