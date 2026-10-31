import { Effect, Predicate, Schema } from 'effect';
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
import { deriveOntosMcpContribution, OntosMcpContributionDerivationError } from '../ontos-mcp-contribution.mts';

const APP_ID = 'party-registry';
const MODULE_ID = 'party.registry';
const DUPLICATE_CANDIDATE_LIST = 'duplicate-candidate-list';

it('omits the contribution when the owner authors none', () => {
  const derived = deriveOntosMcpContribution({
    actions: [],
    api: {},
    appId: APP_ID,
    moduleId: MODULE_ID,
  });
  expect(derived).toBeUndefined();
});

it.effect('the queue contributes a typed read-only MCP tool on its governed endpoint', () =>
  Effect.gen(function* effectGenerator1() {
    const derived = deriveOntosMcpContribution({
      actions: [],
      api: { DuplicateCandidateListApi },
      appId: APP_ID,
      authored: {
        ...partyRegistryMcpContribution,
        actions: {},
        reads: { [DUPLICATE_CANDIDATE_LIST]: partyRegistryMcpContribution.reads[DUPLICATE_CANDIDATE_LIST] },
      },
      moduleId: MODULE_ID,
    });
    if (derived === undefined) {
      expect.unreachable('Expected the queue MCP contribution');
    }
    const catalog = yield* Schema.decodeEffect(OntosMcpToolCatalogJsonSchema)(derived.toolCatalog);
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
  }),
);

it('rejects the queue endpoint when its MCP read entry is missing', () => {
  const input = {
    actions: [],
    api: { DuplicateCandidateListApi },
    appId: APP_ID,
    authored: { ...partyRegistryMcpContribution, actions: {}, reads: {} },
    moduleId: MODULE_ID,
  };
  expect(() => deriveOntosMcpContribution(input)).toThrow(OntosMcpContributionDerivationError);
  expect(() => deriveOntosMcpContribution(input)).toThrow(
    'party.registry: MCP reads not contributed or hidden: duplicate-candidate-list',
  );
});

it.effect('omits an explicitly hidden queue endpoint from the MCP tool catalog', () =>
  Effect.gen(function* effectGenerator3() {
    const derived = deriveOntosMcpContribution({
      actions: [],
      api: { DuplicateCandidateListApi },
      appId: APP_ID,
      authored: {
        ...partyRegistryMcpContribution,
        actions: {},
        reads: { [DUPLICATE_CANDIDATE_LIST]: OntosMcpHidden },
      },
      moduleId: MODULE_ID,
    });
    if (derived === undefined) {
      expect.unreachable('Expected the hidden queue MCP contribution');
    }
    const catalog = yield* Schema.decodeEffect(OntosMcpToolCatalogJsonSchema)(derived.toolCatalog);
    expect(catalog.tools).toEqual([]);
    expect(derived.contribution.toolCatalog.toolCount).toBe(0);
  }),
);

type JsonObject = typeof Schema.JsonObject.Type;
const isJsonObject = Schema.is(Schema.JsonObject);
const isJsonArray = Schema.is(Schema.Array(Schema.Json));

const actionCatalog = (payloadSchema: Schema.Top) =>
  Effect.gen(function* effectGenerator4() {
    const title = { cs: 'Přiřadit protistranu', en: 'Assign counterparty' };
    const action = { agentProposalOnly: true, destructive: false, referenceAudiences: [APP_ID], title };
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
    return yield* Schema.decodeEffect(OntosMcpToolCatalogJsonSchema)(derived.toolCatalog);
  });

/** Expand only generated references; authored references (including recursive ones) must stay unchanged. */
const expandShared = (node: Schema.Json, definitions: JsonObject, authored: JsonObject): Schema.Json => {
  if (isJsonArray(node)) {
    return node.map((child) => expandShared(child, definitions, authored));
  }
  if (!isJsonObject(node)) {
    return node;
  }
  const ref = node.$ref;
  const referenceKey = Predicate.isString(ref) && ref.startsWith('#/$defs/') ? ref.slice('#/$defs/'.length) : undefined;
  if (referenceKey !== undefined && !(referenceKey in authored)) {
    const definition = definitions[referenceKey];
    if (definition === undefined) {
      expect.unreachable(`Missing shared definition ${referenceKey}`);
    }
    return expandShared(definition, definitions, authored);
  }
  return Object.fromEntries(
    Object.entries(node).map(([key, child]) => [key, expandShared(child, definitions, authored)]),
  );
};

it.effect(
  'shares real counterparty schemas without replacing properties, enum arrays or example data with references',
  () =>
    Effect.gen(function* effectGenerator5() {
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
      const catalog = yield* actionCatalog(payload);
      const authored = yield* Schema.decodeUnknownEffect(Schema.JsonObject)(source.definitions);
      const definition = Object.values(catalog.definitions).find(
        (value) => isJsonObject(value) && isJsonArray(value.required) && value.required.includes('resourceType'),
      );
      if (!isJsonObject(definition)) {
        expect.unreachable('Expected the shared counterparty schema');
      }
      expect(definition.properties).toEqual(Schema.toJsonSchemaDocument(CounterpartyRefSchema).schema.properties);
      expect(definition.examples).toEqual([example]);
      for (const tool of catalog.tools) {
        expect(expandShared(tool.inputSchema, catalog.definitions, authored)).toEqual(source.schema);
        const { properties } = tool.inputSchema;
        if (!isJsonObject(properties) || !isJsonObject(properties.status)) {
          expect.unreachable('Expected an inline Action property map and status schema');
        }
        const { status } = properties;
        const ref = status.$ref;
        const statusSchema = Predicate.isString(ref) ? catalog.definitions[ref.slice('#/$defs/'.length)] : status;
        expect(isJsonObject(statusSchema) && isJsonArray(statusSchema.enum)).toBe(true);
        expect(tool.agentProposalOnly).toBe(true);
        expect(tool.referenceAudiences).toEqual([APP_ID]);
        expect(tool.invoke.commandTag).toBeUndefined();
      }
    }),
);

it.effect(
  'preserves authored recursive definitions, including names starting with S, while sharing their child schemas',
  () =>
    Effect.gen(function* effectGenerator6() {
      interface ReferenceTree {
        readonly children: readonly ReferenceTree[];
        readonly counterpartyRef: typeof CounterpartyRefSchema.Type;
      }
      const tree: Schema.Codec<ReferenceTree> = Schema.suspend(() =>
        Schema.Struct({ children: Schema.Array(tree), counterpartyRef: CounterpartyRefSchema }),
      ).annotate({ identifier: 'SharedCounterpartyTree' });
      const payload = Schema.Struct({ counterpartyRef: CounterpartyRefSchema, tree });
      const source = Schema.toJsonSchemaDocument(payload);
      const authored = yield* Schema.decodeUnknownEffect(Schema.JsonObject)(source.definitions);
      const catalog = yield* actionCatalog(payload);
      expect(Object.keys(authored)).toContain('SharedCounterpartyTree');
      for (const [name, definition] of Object.entries(authored)) {
        expect(expandShared(catalog.definitions[name] ?? null, catalog.definitions, authored)).toEqual(definition);
      }
      for (const tool of catalog.tools) {
        expect(expandShared(tool.inputSchema, catalog.definitions, authored)).toEqual(source.schema);
      }
      const sharedTree = catalog.definitions.SharedCounterpartyTree;
      const properties = isJsonObject(sharedTree) ? sharedTree.properties : undefined;
      expect(
        isJsonObject(properties) && isJsonObject(properties.counterpartyRef) && properties.counterpartyRef.$ref,
      ).toEqual(expect.stringMatching(/^#\/\$defs\/S[0-9a-f]{12}$/u));
    }),
);
