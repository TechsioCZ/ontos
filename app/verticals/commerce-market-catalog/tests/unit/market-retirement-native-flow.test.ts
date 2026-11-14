import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';
import { getVerticalRuntimeActions, OntosMcpTextSchema } from '@app/core-runtime';

import { commerceMarketCatalogMcpContribution } from '../../shared/mcp/contribution.ts';
import {
  MarketRetirementEffectRecoveryResultSchema,
  MarketRetirementSettlementPending,
  mapMarketRetirementSettlementPendingProblem,
} from '../../shared/market-retirement-admission.ts';
import { outboxWorkers } from '../../src/workers/index.ts';
import { manageMarketRetirementAdmissionAction } from '../../src/actions/manage-market-retirement-admission.action.ts';
import { commerceMarketCatalogBackendRegistration } from '../../vertical.runtime-declaration.ts';

const marketRef = {
  moduleId: 'commerce.market-catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.market-catalog.market',
  tenantId: '11111111-1111-4111-8111-111111111111',
} as const;
const sourceActionInvocationId = '33333333-3333-4333-8333-333333333333';
const committedResult = {
  changed: true,
  definitionRevisionRef: {
    moduleId: 'commerce.market-catalog',
    resourceId: '44444444-4444-4444-8444-444444444444',
    resourceType: 'commerce.market-catalog.market-definition-revision',
    tenantId: marketRef.tenantId,
  },
  lifecycle: 'RETIRED',
  marketRef,
  revision: 4,
} as const;

describe('Native Market retirement flow', () => {
  it('hides the internal admission protocol from MCP without removing its genuine registration', () => {
    expect(commerceMarketCatalogMcpContribution.actions['manage-market-retirement-admission']).toBe('hidden');
    expect(getVerticalRuntimeActions(commerceMarketCatalogBackendRegistration)).toContain(
      manageMarketRetirementAdmissionAction,
    );
    expect(commerceMarketCatalogMcpContribution.actions['retire-market']).not.toBe('hidden');
    expect(commerceMarketCatalogMcpContribution.reads['market-retirement-effect-recovery']).not.toBe('hidden');
  });

  it('projects the settlement-pending failure onto the native committed result instead of a fresh-key retry', () => {
    const problem = mapMarketRetirementSettlementPendingProblem(
      new MarketRetirementSettlementPending({
        code: 'market_retirement_settlement_unavailable',
        committedResult,
        reason: 'The original retirement effect is committed but its Customer Context settlement is still pending',
        sourceActionInvocationId,
      }),
    );
    expect(problem).toMatchObject({
      code: 'market_retirement_settlement_unavailable',
      committedResult,
      pendingSettlement: true,
      resolution: 'RECOVER_ORIGINAL_EFFECT',
      retryCommand: false,
      sourceActionInvocationId,
      status: 503,
    });
  });

  it('carries the committed result in the recovery read and never a settlement without one', () => {
    expect(Schema.is(MarketRetirementEffectRecoveryResultSchema)({ outcome: 'NOT_FOUND' })).toBe(true);
    expect(
      Schema.is(MarketRetirementEffectRecoveryResultSchema)({
        outcome: 'PENDING',
        sourceActionInvocationId,
      }),
    ).toBe(false);
    expect(
      Schema.is(MarketRetirementEffectRecoveryResultSchema)({
        outcome: 'COMMITTED',
        result: committedResult,
        sourceActionInvocationId,
      }),
    ).toBe(false);
  });

  it('describes the native retirement result and no longer advertises a retirement-status read', () => {
    expect(commerceMarketCatalogMcpContribution.reads).toHaveProperty('market-retirement-effect-recovery');
    expect(commerceMarketCatalogMcpContribution.reads).not.toHaveProperty('market-retirement-status');
    expect(commerceMarketCatalogMcpContribution.actions['retire-market']).toMatchObject({
      description: {
        en: expect.stringContaining('MarketLifecycleResult'),
      },
    });
    expect(
      Schema.is(OntosMcpTextSchema)(commerceMarketCatalogMcpContribution.actions['retire-market'].description),
    ).toBe(true);
  });

  it('projects the main market-retired event into search and registers no producerless retirement worker', () => {
    const workers = outboxWorkers.map(({ descriptor }) => descriptor);
    const workerKeys = workers.map(({ workerKey }) => workerKey);
    expect(workerKeys).toEqual([
      'commerce.market-catalog.project-market-activated-to-search',
      'commerce.market-catalog.project-market-created-to-search',
      'commerce.market-catalog.project-market-definition-revised-to-search',
      'commerce.market-catalog.project-market-retired-to-search',
      'commerce.market-catalog.project-market-suspended-to-search',
      'commerce.market-catalog.rebuild-search',
    ]);
    expect(workerKeys).not.toContain('commerce.market-catalog.complete-market-retirement');
    expect(
      workers.find(({ workerKey }) => workerKey === 'commerce.market-catalog.project-market-retired-to-search'),
    ).toMatchObject({
      consumerModuleKey: 'commerce.market-catalog',
      producerModuleKey: 'commerce.market-catalog',
      topic: 'commerce.market-catalog.market-retired.v1',
    });
  });
});
