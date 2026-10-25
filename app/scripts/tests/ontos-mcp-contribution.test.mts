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
