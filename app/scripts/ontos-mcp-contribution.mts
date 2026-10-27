/**
 * Derives the serialized MCP contribution (`manifest.publicSurface.mcp`) of one vertical from its authored
 * contribution and its own executable values: `/reads/<slug>` endpoints of its public HttpApis and its Action
 * registrations. The tools go to a separate tool catalog artifact the contribution pins by digest; JSON Schemas
 * come from the vertical's Effect Schemas, and repeated subtrees are shared through `definitions`.
 */
import { createHash } from 'node:crypto';

import { Array as EffectArray, Effect, Option, Order, Predicate, Schema } from 'effect';
import { HttpApi } from 'effect/unstable/httpapi';

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

import type { OntosModuleManifest } from '../packages/core-runtime/src/modules/manifest.ts';

type ModuleApiExports = OntosModuleManifest['publicSurface']['api'];

type Json = Schema.Json;
type JsonObject = typeof Schema.JsonObject.Type;
type MutableJsonObject = Record<string, Json>;

export class OntosMcpContributionDerivationError extends Schema.TaggedError<OntosMcpContributionDerivationError>()(
  'OntosMcpContributionDerivationError',
  { message: Schema.String },
) {}

const fail = (message: string) => Effect.fail(new OntosMcpContributionDerivationError({ message }));

const isJsonObject = Schema.is(Schema.JsonObject);
const JsonTextSchema = Schema.fromJsonString(Schema.Json);

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

const documentOf = (schema: Schema.Top, label: string) =>
  Effect.gen(function* effectGenerator1() {
    const document = yield* Effect.try({
      catch: (error) =>
        new OntosMcpContributionDerivationError({
          message: `${label}: the JSON Schema cannot be derived (${Predicate.isError(error) ? error.message : String(error)})`,
        }),
      try: () => Schema.toJsonSchemaDocument(schema),
    });
    const { $schema: _dialect, ...root } = yield* Schema.decodeUnknownEffect(Schema.JsonObject)(document.schema);
    const definitions = yield* Schema.decodeUnknownEffect(Schema.JsonObject)(document.definitions);
    return { definitions: { ...definitions }, schema: root } satisfies SchemaDocument;
  });

const resolveRef = (node: Json | undefined, definitions: JsonObject): Json | undefined => {
  if (!isJsonObject(node) || !Predicate.isString(node.$ref)) {
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
  if (EffectArray.isArray<Json | undefined>(values) && values.length === 1 && Predicate.isString(values[0])) {
    return values[0];
  }
  return Predicate.isString(tag.const) ? tag.const : undefined;
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
    EffectArray.isArray<Json | undefined>(branches)
      ? branches.flatMap((branch) => taggedVariants(branch, definitions))
      : [],
  );
};

/** Command arguments: the variant's fields without `_tag`, plus an optional integer `expectedRevision`. */
const commandInputSchema = (variant: JsonObject): JsonObject => {
  const sourceProperties = isJsonObject(variant.properties) ? variant.properties : {};
  const { _tag: _omitted, ...properties } = sourceProperties;
  const required = EffectArray.isArray<Json | undefined>(variant.required)
    ? variant.required.filter(Predicate.isString).filter((name) => name !== '_tag')
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
  };
};

interface ReadEndpoint {
  readonly document: SchemaDocument;
  readonly path: string;
  readonly slug: string;
}

const slugOrder = Order.make<Pick<ReadEndpoint, 'slug'>>((left, right) => {
  const comparison = left.slug.localeCompare(right.slug);
  if (comparison === 0) {
    return 0;
  }
  return comparison < 0 ? -1 : 1;
});

const READ_PATH = /^\/reads\/(?<slug>[a-z0-9-]+)$/u;

interface ReadSchemaEndpoint {
  readonly exportName: string;
  readonly path: string;
  readonly schema: Schema.Top;
  readonly slug: string;
}

const readEndpointsOf = (api: ModuleApiExports) =>
  Effect.gen(function* effectGenerator2() {
    const reads = new Map<string, ReadSchemaEndpoint>();
    const entries = Object.entries(api);
    for (const [exportName, value] of entries) {
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
          reads.set(slug, { exportName, path: endpoint.path, schema, slug });
        },
        onGroup: () => {
          // Endpoint reflection handles the contribution; groups need no separate registration.
        },
      });
    }
    return yield* Effect.forEach([...reads.values()], (read) =>
      Effect.map(documentOf(read.schema, `${read.exportName} ${read.path}`), (document): ReadEndpoint => ({
        document,
        path: read.path,
        slug: read.slug,
      })),
    ).pipe(Effect.map((endpoints) => EffectArray.sort(endpoints, slugOrder)));
  });

const ActionValueSchema = Schema.Struct({
  descriptor: Schema.Struct({
    actionKey: Schema.String.pipe(Schema.brand('OntosMcpActionKey')),
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

type ActionValue = typeof ActionValueSchema.Type;

const actionEndpointOf = Effect.fn('OntosMcpContribution.actionEndpoint')(function* actionEndpointOf(
  action: ActionValue,
  { appId, moduleId }: { readonly appId: string; readonly moduleId: string },
): Effect.fn.Return<ActionEndpoint, OntosMcpContributionDerivationError | Schema.SchemaError> {
  const { actionKey, payloadSchema } = action.descriptor;
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
  };
});

const actionEndpointsOf = (actions: readonly unknown[], moduleId: string, appId: string) =>
  Effect.forEach((rawAction: unknown) =>
    Schema.decodeUnknownEffect(ActionValueSchema)(rawAction).pipe(
      Effect.mapError(
        () => new OntosMcpContributionDerivationError({ message: 'manifest Actions must be Action registrations' }),
      ),
      Effect.flatMap((action) => actionEndpointOf(action, { appId, moduleId })),
    ),
  )(actions).pipe(Effect.map((endpoints) => EffectArray.sort(endpoints, slugOrder)));

/** Visit schema positions only; property maps and annotation data retain their wire structure. */
const schemaMapKeywords = new Set([
  '$defs',
  'definitions',
  'properties',
  'patternProperties',
  'dependentSchemas',
  'dependencies',
]);
const schemaArrayKeywords = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems', 'items']);
const schemaKeywords = new Set([
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

const mapNamedSchemaChild = <E,>(
  [name, child]: readonly [string, Json],
  visit: (schema: Json) => Effect.Effect<Json, E>,
) => visit(child).pipe(Effect.map((result) => [name, result] as const));

const mapSchemaChild = <E,>(
  [keyword, value]: readonly [string, Json],
  visit: (schema: Json) => Effect.Effect<Json, E>,
): Effect.Effect<readonly [string, Json], E> =>
  Effect.gen(function* mapSchemaChildProgram() {
    let mapped = value;
    if (schemaMapKeywords.has(keyword) && isJsonObject(value)) {
      const entries = yield* Effect.forEach(Object.entries(value), (entry) => mapNamedSchemaChild(entry, visit));
      mapped = Object.fromEntries(entries);
    } else if (schemaArrayKeywords.has(keyword)) {
      mapped = EffectArray.isArray<Json | undefined>(value) ? yield* Effect.forEach(visit)(value) : yield* visit(value);
    } else if (schemaKeywords.has(keyword)) {
      mapped = yield* visit(value);
    }
    return [keyword, mapped] as const;
  });

const mapSchemaChildren = <E,>(
  schema: JsonObject,
  visit: (schema: Json) => Effect.Effect<Json, E>,
): Effect.Effect<JsonObject, E> =>
  Effect.forEach(Object.entries(schema), (entry) => mapSchemaChild(entry, visit)).pipe(
    Effect.map((entries) => Object.fromEntries(entries)),
  );

interface SchemaSharingState {
  readonly counts: ReadonlyMap<string, number>;
  readonly definitions: MutableJsonObject;
  readonly keys: Map<string, string>;
}

const shareSchemaNode = (
  node: Json,
  isRoot: boolean,
  state: SchemaSharingState,
): Effect.Effect<Json, Schema.SchemaError> =>
  Effect.gen(function* shareSchemaNodeProgram() {
    if (!isJsonObject(node)) {
      return node;
    }
    const text = yield* Schema.encodeUnknownEffect(JsonTextSchema)(node);
    if (!isRoot && text.length >= 300 && (state.counts.get(text) ?? 0) > 1) {
      let key = state.keys.get(text);
      if (key === undefined) {
        const base = `S${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
        key = base;
        let suffix = 2;
        while (key in state.definitions) {
          key = `${base}_${suffix}`;
          suffix += 1;
        }
        state.keys.set(text, key);
        state.definitions[key] = yield* shareSchemaNode(node, true, state);
      }
      return { $ref: `#/$defs/${key}` };
    }
    return yield* mapSchemaChildren(node, (child) => shareSchemaNode(child, false, state));
  });

/** Repeated subtree IDs hash the exact insertion-ordered JSON text, preserving the published catalog IDs. */
const shareRepeatedSubtrees = (tools: readonly { readonly schema: JsonObject }[], definitions: MutableJsonObject) =>
  Effect.gen(function* effectGenerator5() {
    const counts = new Map<string, number>();
    const count = (node: Json): Effect.Effect<Json, Schema.SchemaError> =>
      Effect.gen(function* effectGenerator6() {
        if (isJsonObject(node)) {
          const text = yield* Schema.encodeUnknownEffect(JsonTextSchema)(node);
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
    const state: SchemaSharingState = { counts, definitions, keys: new Map() };
    // Snapshot authored definitions before sharing adds generated ones; authored names can start with S.
    for (const [name, value] of Object.entries(definitions)) {
      definitions[name] = yield* shareSchemaNode(value, true, state);
    }
    return yield* Effect.forEach((tool: { readonly schema: JsonObject }) =>
      shareSchemaNode(tool.schema, true, state).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.JsonObject))),
    )(tools);
  });

const mergeDefinitions = (target: MutableJsonObject, source: JsonObject, label: string) =>
  Effect.gen(function* effectGenerator8() {
    for (const [name, value] of Object.entries(source)) {
      if (name in target) {
        // Definitions must have the same wire representation, including key order, as before.
        const previous = yield* Schema.encodeUnknownEffect(JsonTextSchema)(target[name]);
        const next = yield* Schema.encodeUnknownEffect(JsonTextSchema)(value);
        if (previous !== next) {
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
) =>
  Effect.gen(function* effectGenerator9() {
    const missing = EffectArray.sort(
      [...available].filter((key) => !(key in declared)),
      Order.String,
    );
    if (missing.length > 0) {
      yield* fail(`${moduleId}: MCP ${group} not contributed or hidden: ${missing.join(', ')}`);
    }
    const unknown = EffectArray.sort(
      Object.keys(declared).filter((key) => !available.has(key)),
      Order.String,
    );
    if (unknown.length > 0) {
      yield* fail(`${moduleId}: MCP ${group} do not exist in the module: ${unknown.join(', ')}`);
    }
  });

type MutableToolText = { -readonly [Key in keyof OntosMcpToolTextInput]: OntosMcpToolTextInput[Key] };
type WriteFields = Pick<
  OntosMcpTool,
  'agentProposalOnly' | 'description' | 'destructive' | 'liveRight' | 'referenceAudiences' | 'title'
>;
type MutableWriteFields = { -readonly [Key in keyof WriteFields]: WriteFields[Key] };

const textFields = (entry: OntosMcpToolTextInput): OntosMcpToolTextInput => {
  const fields: MutableToolText = { title: entry.title };
  if (entry.description !== undefined) {
    fields.description = entry.description;
  }
  return fields;
};

const writeFields = (entry: OntosMcpWriteInput, verb: string) => {
  const fields: MutableWriteFields = {
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
  readonly api: ModuleApiExports;
  readonly appId: string;
  readonly authored?: OntosMcpContributionInput | undefined;
  readonly moduleId: string;
}

export interface DerivedOntosMcpContribution {
  /** `manifest.publicSurface.mcp` of the deployment contract. */
  readonly contribution: OntosMcpContribution;
  /** Exact text of the tool catalog artifact the contribution pins (served at its `toolCatalog.path`). */
  readonly toolCatalog: string;
}

interface DraftToolsInput {
  readonly appId: string;
  readonly authored: OntosMcpContributionInput;
  readonly commandActions: readonly ActionEndpoint[];
  readonly moduleId: string;
  readonly namedActions: readonly ActionEndpoint[];
  readonly reads: readonly ReadEndpoint[];
}

const draftTools = (input: DraftToolsInput, definitions: MutableJsonObject) =>
  Effect.gen(function* effectGenerator10() {
    const { appId, authored, commandActions, moduleId, namedActions, reads } = input;
    const drafts: { readonly schema: JsonObject; readonly tool: Omit<OntosMcpTool, 'inputSchema'> }[] = [];
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

type MutableContribution = { -readonly [Key in keyof OntosMcpContribution]: OntosMcpContribution[Key] };

const contributionOf = (authored: OntosMcpContributionInput, toolCatalog: string, toolCount: number) => {
  const contribution: MutableContribution = {
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
  const { revision } = authored;
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

/** None when the vertical authors no MCP contribution. */
export const deriveOntosMcpContribution = (
  input: DeriveOntosMcpContributionInput,
): Effect.Effect<
  Option.Option<DerivedOntosMcpContribution>,
  OntosMcpContributionDerivationError | Schema.SchemaError
> =>
  Effect.gen(function* effectGenerator11() {
    const { appId, authored, moduleId } = input;
    if (authored === undefined) {
      return Option.none();
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
    const drafts = yield* draftTools({ appId, authored, commandActions, moduleId, namedActions, reads }, definitions);
    for (const key of ['id', 'name'] as const) {
      const seen = new Set<string>();
      for (const { tool } of drafts) {
        if (seen.has(tool[key])) {
          return yield* fail(`${moduleId}: duplicate MCP tool ${key} ${tool[key]}`);
        }
        seen.add(tool[key]);
      }
    }
    const schemas = yield* shareRepeatedSubtrees(drafts, definitions);
    const toolCatalog = yield* Schema.encodeUnknownEffect(OntosMcpToolCatalogJsonSchema)({
      definitions,
      tools: drafts.map(({ tool }, index) => ({ ...tool, inputSchema: schemas[index] ?? {} })),
    });
    const contribution = contributionOf(authored, toolCatalog, drafts.length);

    return Option.some({
      contribution: yield* Schema.decodeUnknownEffect(OntosMcpContributionSchema, { onExcessProperty: 'error' })(
        contribution,
      ),
      toolCatalog,
    });
  });
