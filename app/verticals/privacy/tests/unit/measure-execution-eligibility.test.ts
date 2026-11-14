import { Effect, Option, Schema } from 'effect';
import { OwnerExecutionOutcomeSchema } from '../../shared/domain/privacy-measure-handoff.ts';
import { describe, expect, it } from 'effect-rstest';
import {
  evaluateMeasureExecutionEligibility,
  measureExecutionContentIsQualified,
} from '../../src/services/measure-execution-eligibility.service.ts';
import type { MeasureExecutionEligibilityServices } from '../../src/services/measure-execution-eligibility.service.ts';
import { makeMeasureExecutionFixture } from '../support/measure-execution.fixture.ts';
import { PrivacyOperationPersistenceError } from '../../src/persistence/privacy-operation-repository.ts';

const tenantId = 'f6000000-0000-4000-8000-000000000001';
const fixture = makeMeasureExecutionFixture(tenantId);
const scope = { legalEntityId: 'f6000000-0000-4000-8000-000000000002', tenantId };
const now = '2026-11-07T10:00:00.000Z';
const services: MeasureExecutionEligibilityServices = {
  decisions: () => Effect.succeed([fixture.decision]),
  evaluation: () => Effect.succeed(fixture.evaluation),
  handoff: () => Effect.succeed(Option.some({ handoff: fixture.handoff, status: 'RECEIVED' })),
};
const run = (ports = services, handoff = fixture.handoff) =>
  evaluateMeasureExecutionEligibility({ handoff }, scope, ports, now);
describe('exact current destructive measure eligibility', () => {
  it.effect(
    'rechecks a nonterminal Symmy owner block only with exact persisted outcome evidence and current protections',
    () =>
      Effect.gen(function* retryCurrentOwnerBlock() {
        const blockedOutcome = Schema.decodeUnknownSync(OwnerExecutionOutcomeSchema)({
          attempt: 1,
          evidenceRefs: ['internal:actual-owner-block'],
          idempotencyKey: fixture.handoff.idempotencyKey,
          includedResourceRefs: [],
          measureId: fixture.handoff.measureId,
          occurredAt: now,
          outcomeId: 'internal:blocked-outcome',
          owningCapability: 'integration.symmy',
          reason: 'Current retention blocker',
          recordedAt: now,
          remainingResourceRefs: fixture.handoff.resourceRefs,
          sourceDecisionRef: fixture.handoff.sourceDecisionRef,
          sourceDecisionRevision: fixture.handoff.sourceDecisionRevision,
          status: 'BLOCKED',
          taskId: fixture.handoff.taskId,
        });
        const retry = {
          ...services,
          handoff: () => Effect.succeed(Option.some({ blockedOutcome, handoff: fixture.handoff, status: 'BLOCKED' })),
        };
        expect((yield* run(retry)).status).toBe('CURRENT_APPROVED');
        expect(
          (yield* run({
            ...retry,
            evaluation: () =>
              Effect.succeed({ ...fixture.evaluation, blockerRefs: ['hold:active'], status: 'BLOCKED' }),
          })).status,
        ).toBe('BLOCKED');
        for (const changed of [
          { ...blockedOutcome, remainingResourceRefs: [] },
          { ...blockedOutcome, sourceDecisionRevision: 2 },
          { ...blockedOutcome, owningCapability: 'party.registry' },
        ]) {
          expect(
            (yield* run({
              ...retry,
              handoff: () =>
                Effect.succeed(Option.some({ blockedOutcome: changed, handoff: fixture.handoff, status: 'BLOCKED' })),
            })).status,
          ).toBe('BLOCKED');
        }
      }),
  );
  it.effect('accepts the actual exact native dispatch and current determinate evaluation', () =>
    Effect.gen(function* test() {
      expect(yield* run()).toEqual({
        authorityReceiptRef: fixture.decision.decisionRef,
        checkedAt: now,
        sourceDecisionRevision: 1,
        status: 'CURRENT_APPROVED',
      });
    }),
  );
  it.effect('refuses generic content, foreign tenant, altered target and unsupported source revision', () =>
    Effect.gen(function* test() {
      expect(
        measureExecutionContentIsQualified({ ...fixture.handoff, contentScopeRefs: ['integration.symmy.job-intent'] }),
      ).toBe(false);
      for (const handoff of [
        { ...fixture.handoff, tenantId: `${tenantId}:foreign` },
        { ...fixture.handoff, sourceDecisionRevision: 2 },
        { ...fixture.handoff, resourceRefs: ['other:resource'] },
      ]) {
        expect((yield* run(services, handoff)).status).toBe('BLOCKED');
      }
    }),
  );
  it.effect('refuses a forged or missing persisted dispatch and conflicting decision history', () =>
    Effect.gen(function* test() {
      expect((yield* run({ ...services, handoff: () => Effect.succeed(Option.none()) })).status).toBe('BLOCKED');
      expect((yield* run(services, { ...fixture.handoff, taskId: 'other:task' })).status).toBe('BLOCKED');
      expect(
        (yield* run({
          ...services,
          handoff: () => Effect.succeed(Option.some({ handoff: fixture.handoff, status: 'BLOCKED' })),
        })).status,
      ).toBe('BLOCKED');
      expect(
        (yield* run({
          ...services,
          decisions: () => Effect.succeed([fixture.decision, { ...fixture.decision, decisionRef: 'decision:other' }]),
        })).status,
      ).toBe('BLOCKED');
    }),
  );
  it.effect(
    'does not treat a formerly approved decision as permission after a current blocker or unavailable rule',
    () =>
      Effect.gen(function* test() {
        expect(
          (yield* run({
            ...services,
            evaluation: () =>
              Effect.succeed({ ...fixture.evaluation, blockerRefs: ['hold:current'], status: 'BLOCKED' }),
          })).status,
        ).toBe('BLOCKED');
        const error = yield* Effect.flip(
          run({
            ...services,
            evaluation: () =>
              Effect.fail(
                new PrivacyOperationPersistenceError({
                  code: 'privacy_operation_persistence_unavailable',
                  reason: 'fixture:missing-current-authority',
                }),
              ),
          }),
        );
        expect(error.code).toBe('privacy_operation_persistence_unavailable');
      }),
  );
});
