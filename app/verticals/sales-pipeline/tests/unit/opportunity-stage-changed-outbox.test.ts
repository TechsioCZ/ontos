import { ContextAccess } from '@app/core-runtime';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import {
  OutboxPayloadSchema,
  opportunityStageChangedIdempotencyKey,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/sales-pipeline/outbox/opportunity-stage-changed';
import { DateTime, Effect, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ApplyCommandPayloadSchema, SalesPipelineCommandSchema } from '../../shared/actions/apply-command.ts';
import type { SalesPipelineState } from '../../shared/apis/records.ts';
import type { OpportunityStage } from '../../shared/model/opportunity.ts';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';
import { evolveOpportunityState } from '../../src/services/persistence.service.ts';
import type { AppliedCommand } from '../../src/services/persistence.service.ts';

type CommandInput = typeof SalesPipelineCommandSchema.Encoded;

const tenantId = '91000000-0000-4000-8000-000000000001';
const legalEntityId = '92000000-0000-4000-8000-000000000001';
const partyId = '50000000-0000-4000-8000-000000000001';
const employeeId = '40000000-0000-4000-8000-000000000001';
const productId = '30000000-0000-4000-8000-000000000001';
const opportunityA = '60000000-0000-4000-8000-000000000001';
const opportunityB = '60000000-0000-4000-8000-000000000002';
const createdAt = DateTime.makeUnsafe('2026-10-01T08:00:00Z');
const changedAt = DateTime.makeUnsafe('2026-10-13T09:30:00Z');
const principal = {
  authBindingId: '93000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:sales-pipeline-outbox',
  authMethod: 'session',
  legalEntityId,
  principalId: '94000000-0000-4000-8000-000000000001',
  tenantId,
} as const;

const productLine = {
  productId,
  productName: 'Kancelářská židle',
  quantity: 2,
  unitPriceMinor: 450_000,
  vatRate: 21 as const,
};
const freeTextLine = { productName: 'Montáž na místě', quantity: 1, unitPriceMinor: 120_000, vatRate: 21 as const };
// The substituted owner services never reach ContextAccess; the requirement only comes from the production factory.
const unusedContextAccessLayer = Layer.succeed(ContextAccess, {
  businessPermissions: () => Effect.succeed([]),
  legalEntities: () => Effect.succeed([]),
  modules: () => Effect.succeed([]),
  resources: () => Effect.succeed([]),
  tenants: () => Effect.succeed([]),
});

const decodeCommand = Schema.decodeUnknownEffect(SalesPipelineCommandSchema);
const decodePayload = Schema.decodeUnknownEffect(ApplyCommandPayloadSchema);
const decodeMessagePayload = Schema.decodeUnknownEffect(OutboxPayloadSchema);

const seed = Effect.fn('seed')(function* seed(id: string, stage: OpportunityStage) {
  const command = yield* decodeCommand({
    _tag: 'CreateOpportunity',
    expectedCloseDate: '2026-12-31',
    lines: [productLine, freeTextLine],
    ownerEmployeeId: employeeId,
    partyId,
    stage,
    title: `Deal ${id}`,
  });
  return command;
});

/** In-memory owner services: the real state machine, a revision counter, and a fixed clock. */
const inMemoryServices = (initial: SalesPipelineState, initialRevision: number) => {
  let state = initial;
  let revision = initialRevision;
  return {
    apply: Effect.fn('SalesPipelineTest.apply')(function* apply(
      command: typeof SalesPipelineCommandSchema.Type,
      _expectedRevision: number,
      invocationId: string,
    ) {
      const change = yield* evolveOpportunityState(state, command, { invocationId, now: changedAt });
      const { results: bulkResults } = change;
      const results = bulkResults === undefined ? {} : { results: [...bulkResults] };
      if (change.affected.length === 0) {
        const unchanged: AppliedCommand = {
          changedAt,
          result: { opportunities: [], revision, ...results },
          stageChanges: [],
        };
        return unchanged;
      }
      ({ state } = change);
      revision += 1;
      const applied: AppliedCommand = {
        changedAt,
        result: { opportunities: [...change.affected], revision, ...results },
        stageChanges: change.stageChanges,
      };
      return applied;
    }),
    loadRecords: () => Effect.die('loadRecords is not used by apply-command'),
  };
};

const stateWith = Effect.fn('stateWith')(function* stateWith(
  entries: readonly (readonly [string, OpportunityStage])[],
) {
  let state: SalesPipelineState = { opportunities: [] };
  for (const [id, stage] of entries) {
    const command = yield* seed(id, stage);
    ({ state } = yield* evolveOpportunityState(state, command, { invocationId: id, now: createdAt }));
  }
  return state;
});

const runCommand = Effect.fn('runCommand')(function* runCommand(state: SalesPipelineState, command: CommandInput) {
  const harness = yield* makeActionTestHarness({
    actionPermission: 'allowed',
    legalEntityPermission: 'allowed',
    services: [bindActionTestServices(applyCommandAction, inMemoryServices(state, 7))],
    tenantPermission: 'allowed',
  });
  const payload = yield* decodePayload({ command, expectedRevision: 7 });
  const result = yield* harness.runtime
    .runAction({
      payload,
      principal,
      registration: applyCommandAction,
      transport: { correlationId: 'sales-pipeline-outbox', idempotencyKey: `outbox-${command._tag}` },
    })
    .pipe(Effect.provide(unusedContextAccessLayer));
  const [committed] = harness.snapshot().committed;
  return { evidence: committed?.evidence, result };
});

it.effect('ChangeOpportunityStage to WON commits exactly one stage-changed message with the line snapshot', () =>
  Effect.gen(function* wonMessage() {
    const state = yield* stateWith([[opportunityA, 'NEGOTIATION']]);
    const { evidence, result } = yield* runCommand(state, {
      _tag: 'ChangeOpportunityStage',
      id: opportunityA,
      toStage: 'WON',
    });

    expect(result.revision).toBe(8);
    expect(evidence?.outboxMessages).toHaveLength(1);
    expect(evidence?.domainEvents).toHaveLength(1);
    const [collected] = evidence?.outboxMessages ?? [];
    expect(collected?.domainEventIndex).toBe(0);
    expect(collected?.message.topic).toBe('sales.pipeline.opportunity-stage-changed.v1');
    expect(collected?.message.producerModuleKey).toBe('demo.sales-pipeline');
    expect(evidence?.domainEvents[0]).toMatchObject({
      eventType: 'sales.pipeline.opportunity-stage-changed.v1',
      payloadJson: { fromStage: 'NEGOTIATION', opportunityId: opportunityA, revision: 8, toStage: 'WON' },
      subjectResourceId: opportunityA,
      subjectResourceType: 'demo.sales-pipeline.opportunity',
    });
    // Free-text lines carry no productId, so the frozen contract leaves them out; the amount covers every line.
    expect(collected?.message.payloadJson).toEqual({
      amountMinor: 1_020_000,
      changedAt: '2026-10-13T09:30:00.000Z',
      currency: 'CZK',
      fromStage: 'NEGOTIATION',
      lines: [productLine],
      opportunityId: opportunityA,
      ownerEmployeeId: employeeId,
      partyId,
      revision: 8,
      toStage: 'WON',
    });
  }),
);

it.effect('the committed message matches the billing subscription key and decodes with the consumer schema', () =>
  Effect.gen(function* consumerContract() {
    const state = yield* stateWith([[opportunityA, 'PROPOSAL']]);
    const { evidence } = yield* runCommand(state, { _tag: 'ChangeOpportunityStage', id: opportunityA, toStage: 'WON' });
    const [collected] = evidence?.outboxMessages ?? [];

    // Core matches exactly on producer module and topic; the billing worker subscribes with these constants.
    expect(collected?.message.producerModuleKey).toBe(outboxProducerModuleKey);
    expect(collected?.message.topic).toBe(outboxTopic);
    const decoded = yield* decodeMessagePayload(collected?.message.payloadJson);
    expect(decoded.toStage).toBe('WON');
    expect(opportunityStageChangedIdempotencyKey(decoded)).toBe(`${opportunityA}:WON:8`);
  }),
);

it.effect('creation publishes only when the opportunity is created directly as WON', () =>
  Effect.gen(function* creation() {
    const lead = yield* runCommand(
      { opportunities: [] },
      {
        _tag: 'CreateOpportunity',
        expectedCloseDate: '2026-12-31',
        lines: [productLine],
        partyId,
        title: 'Lead deal',
      },
    );
    expect(lead.evidence?.outboxMessages).toEqual([]);
    expect(lead.evidence?.domainEvents).toEqual([]);

    const won = yield* runCommand(
      { opportunities: [] },
      {
        _tag: 'CreateOpportunity',
        expectedCloseDate: '2026-12-31',
        lines: [productLine],
        partyId,
        stage: 'WON',
        title: 'Signed deal',
      },
    );
    expect(won.evidence?.outboxMessages).toHaveLength(1);
    const payload = won.evidence?.outboxMessages[0]?.message.payloadJson;
    expect(payload).toMatchObject({ amountMinor: 900_000, lines: [productLine], revision: 8, toStage: 'WON' });
    expect(payload).not.toHaveProperty('fromStage');
    expect(payload).not.toHaveProperty('ownerEmployeeId');
  }),
);

it.effect('a bulk stage change publishes one message per changed opportunity; edits without a stage change none', () =>
  Effect.gen(function* bulk() {
    const state = yield* stateWith([
      [opportunityA, 'LEAD'],
      [opportunityB, 'QUALIFIED'],
    ]);
    const moved = yield* runCommand(state, {
      _tag: 'BulkUpdateOpportunities',
      ids: [opportunityA, opportunityB],
      patch: { stage: 'PROPOSAL' },
    });
    expect(moved.evidence?.outboxMessages.map((entry) => entry.domainEventIndex)).toEqual([0, 1]);
    expect(moved.evidence?.outboxMessages.map((entry) => entry.message.payloadJson)).toMatchObject([
      { fromStage: 'LEAD', opportunityId: opportunityA, revision: 8, toStage: 'PROPOSAL' },
      { fromStage: 'QUALIFIED', opportunityId: opportunityB, revision: 8, toStage: 'PROPOSAL' },
    ]);

    const edited = yield* runCommand(state, {
      _tag: 'UpdateOpportunity',
      id: opportunityA,
      patch: { title: 'Renamed deal' },
    });
    expect(edited.evidence?.outboxMessages).toEqual([]);
  }),
);
