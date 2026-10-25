import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  OntosMcpHidden,
  OntosMcpToolCatalogJsonSchema,
} from '../../packages/core-runtime/src/modules/mcp-contribution.ts';
import {
  DuplicateCandidateListApi,
  DuplicateCandidateListRequestSchema,
} from '../../verticals/party-registry/shared/apis/duplicate-candidate-list.ts';
import { partyRegistryMcpContribution } from '../../verticals/party-registry/shared/mcp/contribution.ts';
import { CounterpartyRefSchema } from '../../verticals/party-registry/shared/resources/counterparty.ts';
import { deriveOntosMcpContribution } from '../ontos-mcp-contribution.mts';

const APP_ID = 'party-registry';
const MODULE_ID = 'party.registry';

it('the queue contributes a typed read-only MCP tool on its governed endpoint', () => {
  const derived = deriveOntosMcpContribution({
    actions: [],
    api: { DuplicateCandidateListApi },
    appId: APP_ID,
    authored: {
      ...partyRegistryMcpContribution,
      actions: {},
      reads: { 'duplicate-candidate-list': partyRegistryMcpContribution.reads['duplicate-candidate-list'] },
    },
    moduleId: MODULE_ID,
  });
  if (derived === undefined) {
    expect.unreachable('Expected the queue MCP contribution');
  }
  const catalog = Schema.decodeSync(OntosMcpToolCatalogJsonSchema)(derived.toolCatalog);
  expect(catalog.tools).toEqual([
    {
      access: 'read',
      agentProposalOnly: false,
      destructive: false,
      id: 'party.registry/read/duplicate-candidate-list',
      inputSchema: Schema.toJsonSchemaDocument(DuplicateCandidateListRequestSchema).schema,
      invoke: { path: '/reads/duplicate-candidate-list' },
      name: 'party_registry__read_duplicate_candidate_list',
      referenceAudiences: [],
      title: { cs: 'Seznam možných duplicitních subjektů', en: 'Duplicate candidate list' },
    },
  ]);
});

it('rejects the queue endpoint when its MCP read entry is missing', () => {
  expect(() =>
    deriveOntosMcpContribution({
      actions: [],
      api: { DuplicateCandidateListApi },
      appId: APP_ID,
      authored: { ...partyRegistryMcpContribution, actions: {}, reads: {} },
      moduleId: MODULE_ID,
    }),
  ).toThrow('party.registry: MCP reads not contributed or hidden: duplicate-candidate-list');
});

it('omits an explicitly hidden queue endpoint from the MCP tool catalog', () => {
  const derived = deriveOntosMcpContribution({
    actions: [],
    api: { DuplicateCandidateListApi },
    appId: APP_ID,
    authored: {
      ...partyRegistryMcpContribution,
      actions: {},
      reads: { 'duplicate-candidate-list': OntosMcpHidden },
    },
    moduleId: MODULE_ID,
  });
  if (derived === undefined) {
    expect.unreachable('Expected the hidden queue MCP contribution');
  }
  const catalog = Schema.decodeSync(OntosMcpToolCatalogJsonSchema)(derived.toolCatalog);
  expect(catalog.tools).toEqual([]);
  expect(derived.contribution.toolCatalog.toolCount).toBe(0);
});

type JsonObject = { readonly [key: string]: Schema.Json };
const isJsonObject = (value: Schema.Json | undefined): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const actionCatalog = (payloadSchema: Schema.Top) => {
  const title = { cs: 'Přiřadit protistranu', en: 'Assign counterparty' };
  const action = { agentProposalOnly: true, destructive: false, referenceAudiences: ['party-registry'], title };
  const derived = deriveOntosMcpContribution({
    actions: ['assign', 'replace'].map((slug) => ({
      descriptor: { actionKey: `${MODULE_ID}.${slug}`, payloadSchema },
    })),
    api: {},
    appId: APP_ID,
    authored: {
      ...partyRegistryMcpContribution,
      actions: { assign: action, replace: action },
      reads: {},
    },
    moduleId: MODULE_ID,
  });
  if (derived === undefined) {
    expect.unreachable('Expected the Action MCP contribution');
  }
  expect(derived.contribution.toolCatalog.toolCount).toBe(2);
  return Schema.decodeSync(OntosMcpToolCatalogJsonSchema)(derived.toolCatalog);
};

/** Expand only generated references; authored references (including recursive ones) must stay unchanged. */
const expandShared = (node: Schema.Json, definitions: JsonObject, authored: JsonObject): Schema.Json => {
  if (Array.isArray(node)) {
    return node.map((child) => expandShared(child, definitions, authored));
  }
  if (!isJsonObject(node)) {
    return node;
  }
  const ref = node['$ref'];
  const key = typeof ref === 'string' && ref.startsWith('#/$defs/') ? ref.slice('#/$defs/'.length) : undefined;
  if (key !== undefined && !(key in authored)) {
    const definition = definitions[key];
    if (definition === undefined) {
      expect.unreachable(`Missing shared definition ${key}`);
    }
    return expandShared(definition, definitions, authored);
  }
  return Object.fromEntries(
    Object.entries(node).map(([key, child]) => [key, expandShared(child, definitions, authored)]),
  );
};

it('shares real counterparty schemas without replacing properties, enum arrays or example data with references', () => {
  // This exact resource schema is repeated across Commerce Actions; its property map alone exceeds 300 characters.
  const example = {
    moduleId: 'party.registry',
    resourceId: 'counterparty-'.repeat(24),
    resourceType: 'party.registry.counterparty',
    tenantId: '00000000-0000-0000-0000-000000000000',
  } as const;
  const counterparty = CounterpartyRefSchema.annotate({ examples: [example] });
  const payload = Schema.Struct({
    counterpartyRef: counterparty,
    relatedCounterpartyRef: counterparty,
    status: Schema.Literals(['pending-'.repeat(50), 'approved-'.repeat(50)]),
  });
  const source = Schema.toJsonSchemaDocument(payload);
  const catalog = actionCatalog(payload);
  const definition = Object.values(catalog.definitions).find(
    (value) => isJsonObject(value) && Array.isArray(value['required']) && value['required'].includes('resourceType'),
  );
  if (!isJsonObject(definition)) {
    expect.unreachable('Expected the shared counterparty schema');
  }
  expect(definition['properties']).toEqual(Schema.toJsonSchemaDocument(CounterpartyRefSchema).schema['properties']);
  expect(definition['examples']).toEqual([example]);
  for (const tool of catalog.tools) {
    expect(expandShared(tool.inputSchema, catalog.definitions, source.definitions as JsonObject)).toEqual(
      source.schema,
    );
    const properties = tool.inputSchema['properties'];
    if (!isJsonObject(properties) || !isJsonObject(properties['status'])) {
      expect.unreachable('Expected an inline Action property map and status schema');
    }
    const status = properties['status'];
    const ref = status['$ref'];
    const statusSchema = typeof ref === 'string' ? catalog.definitions[ref.slice('#/$defs/'.length)] : status;
    expect(isJsonObject(statusSchema) && Array.isArray(statusSchema['enum'])).toBe(true);
    expect(tool.agentProposalOnly).toBe(true);
    expect(tool.referenceAudiences).toEqual(['party-registry']);
    expect(tool.invoke.commandTag).toBeUndefined();
  }
});

it('preserves authored recursive definitions, including names starting with S, while sharing their child schemas', () => {
  interface ReferenceTree {
    readonly children: readonly ReferenceTree[];
    readonly counterpartyRef: typeof CounterpartyRefSchema.Type;
  }
  const tree: Schema.Codec<ReferenceTree> = Schema.suspend(() =>
    Schema.Struct({ children: Schema.Array(tree), counterpartyRef: CounterpartyRefSchema }),
  ).annotate({ identifier: 'SharedCounterpartyTree' });
  const payload = Schema.Struct({ tree, counterpartyRef: CounterpartyRefSchema });
  const source = Schema.toJsonSchemaDocument(payload);
  const authored = source.definitions as JsonObject;
  const catalog = actionCatalog(payload);
  expect(Object.keys(authored)).toContain('SharedCounterpartyTree');
  for (const [name, definition] of Object.entries(authored)) {
    expect(expandShared(catalog.definitions[name] ?? null, catalog.definitions, authored)).toEqual(definition);
  }
  for (const tool of catalog.tools) {
    expect(expandShared(tool.inputSchema, catalog.definitions, authored)).toEqual(source.schema);
  }
  const sharedTree = catalog.definitions['SharedCounterpartyTree'];
  const properties = isJsonObject(sharedTree) ? sharedTree['properties'] : undefined;
  expect(
    isJsonObject(properties) && isJsonObject(properties['counterpartyRef']) && properties['counterpartyRef']['$ref'],
  ).toEqual(expect.stringMatching(/^#\/\$defs\/S[0-9a-f]{12}$/u));
});
