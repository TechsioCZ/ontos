import {
  PrivacyMeasureHandoffSchema,
  validateOwnerExecutionAuthorityResult,
} from '@app/privacy/domain/privacy-measure-handoff';
import type { PrivacyMeasureHandoff } from '@app/privacy/domain/privacy-measure-handoff';
import type { OperationalScope } from '@app/core-runtime';
import { getTableName } from 'drizzle-orm';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type { RecordOwnerExecutionEvidencePayload } from '../../shared/owner-execution-evidence.ts';
import { PrivacyOwnerCoverageRequestSchema } from '../../shared/apis/privacy-owner-coverage.ts';
import { scopePartRefs } from '../../shared/privacy-owner/inventory.ts';
import { COMMUNICATIONS_TABLES } from '../../src/database/schema.ts';
import { ownerExecutionEvidenceFor } from '../../src/services/owner-execution-evidence.service.ts';
import { recordPrivacyMeasureHandoff } from '../../src/services/privacy-measure-handoff-record.ts';
import { privacyOwnerExecutionReceiptForScope } from '../../src/services/privacy-owner-execution-receipt.service.ts';
import { privacyOwnerCoverageForScope } from '../../src/services/privacy-owner-coverage.service.ts';
import { decideOne, step } from '../support/history-world.ts';
import type { World } from '../support/history-world.ts';
import { handoffDouble } from '../support/intake-fixtures.ts';
import { intakeWorld } from '../support/intake-world.ts';
import { makeRuntimeDatabase, nativeServices, nextId } from '../support/persistence.fixture.ts';

/**
 * [#1410 AC-14 AC-15 AC-16] The owner receipt of a Privacy Measure on native PostgreSQL, as the runtime role, over REAL stored
 * requests, intents and attempts: the handoff record, the human-confirmed evidence Action service, the real coverage and the
 * existing outcome evaluator behind the receipt service. The Privacy side is the labelled handoff of the fixture. Nothing is
 * mocked between the Read and the tables, and no step changes any owner data.
 */

const decodeCoverageRequest = Schema.decodeUnknownSync(PrivacyOwnerCoverageRequestSchema);
const setup = () => makeRuntimeDatabase().pipe(Effect.flatMap((database) => intakeWorld(database, {})));
const operationalScope = (tenantId: string): OperationalScope => ({
  authContextRef: 'job:communications-privacy-receipt-tests:run:1',
  authMethod: 'system',
  correlationId: 'communications-privacy-receipt-tests',
  principalId: '00000000-0000-4000-8000-0000000000b1',
  tenantId,
});
const lookup = {
  _tag: 'SUBJECT_REFERENCE' as const,
  lookupRef: 'lookup-customer-1',
  moduleId: 'fixture.party',
  resourceId: 'customer-1',
  resourceType: 'fixture.recipient',
};
const ownerScope = {
  controllerRef: 'FICTIONAL-controller',
  requestedScopePartRefs: [...scopePartRefs],
  requestedScopeRef: 'FICTIONAL-requested-scope',
  trustedLookups: [lookup],
};
/** A frozen picture of every owner table except the two append-only Privacy measure tables. */
const ownerDataHash = (world: World) =>
  world.database.inTenant(world.tenantId, (transaction) =>
    Effect.all(
      COMMUNICATIONS_TABLES.filter((table) => !getTableName(table).startsWith('privacy_')).map((table) =>
        transaction.select().from(table),
      ),
    ).pipe(Effect.map((tables) => JSON.stringify(tables))),
  );

const handoffOf = (
  tenantId: string,
  resourceRefs: readonly string[],
  overrides: Partial<typeof PrivacyMeasureHandoffSchema.Encoded> = {},
) =>
  Schema.decodeUnknownSync(PrivacyMeasureHandoffSchema)({
    contentScopeRefs: ['communications.core.history'],
    controllerObligationRef: null,
    dispositionDecision: 'ANONYMIZE',
    expectedEvidenceRefs: [],
    idempotencyKey: 'FICTIONAL-idempotency-1',
    kind: 'ANONYMIZE',
    measureId: 'FICTIONAL-measure-1',
    ownerScope,
    owningCapability: 'communications.core',
    preconditionRefs: [],
    requestedAt: '2026-11-19T10:00:00.000Z',
    requestedResult: 'anonymize message metadata',
    resourceRefs,
    right: 'ERASURE',
    sourceDecisionRef: 'FICTIONAL-decision-1',
    sourceDecisionRevision: 1,
    subjectRef: 'FICTIONAL-subject-1',
    taskId: 'FICTIONAL-task-1',
    tenantId,
    ...overrides,
  });

const evidenceOf = (
  handoff: PrivacyMeasureHandoff,
  fingerprint: string,
  overrides: Partial<RecordOwnerExecutionEvidencePayload>,
): RecordOwnerExecutionEvidencePayload => ({
  evidenceRef: 'FICTIONAL-evidence-1',
  handoffFingerprint: fingerprint,
  idempotencyKey: handoff.idempotencyKey,
  phase: 'COMPLETED',
  results: [],
  ...overrides,
});

/** A world with real own data of customer-1, the refs the owner itself found for it and the measure over those refs. */
const measureWorld = Effect.gen(function* measureWorld() {
  const world = yield* setup();
  const { intentId, requestId } = yield* decideOne(world);
  yield* step(world, handoffDouble(), intentId);
  const found = yield* world.database.inTenant(world.tenantId, (transaction) =>
    privacyOwnerCoverageForScope(transaction, operationalScope(world.tenantId))
      .coverage(
        decodeCoverageRequest({
          scope: {
            ...ownerScope,
            ownerCapability: 'communications.core',
            subject: { _tag: 'RESOLVED_DATA_SUBJECT', subjectRef: 'FICTIONAL-subject-1' },
            tenantId: world.tenantId,
            trustedLookupRefs: [lookup.lookupRef],
          },
          trustedLookups: [lookup],
        }),
      )
      .pipe(Effect.map(Option.getOrThrow)),
  );
  const refs = found.coverage.coverageParts.flatMap(({ foundContentRefs }) => foundContentRefs);
  const targets = [`communications.core.request:${requestId}`, `communications.core.intent:${intentId}`];
  expect(refs).toEqual(expect.arrayContaining(targets));
  return { targets, world };
});

describe('Communications owner receipt of a Privacy Measure on native PostgreSQL (AC-14 AC-15 AC-16)', () => {
  it.live(
    'is RECEIVED after the handoff, becomes PARTIAL then SUCCEEDED only through human-confirmed evidence, and changes no owner data',
    () =>
      Effect.gen(function* receiptLifecycle() {
        const { targets, world } = yield* measureWorld;
        const handoff = handoffOf(world.tenantId, targets);
        const invocation = yield* nextId;
        const receiptOf = (current: PrivacyMeasureHandoff, attempt = 1) =>
          world.database.inTenant(world.tenantId, (transaction) =>
            privacyOwnerExecutionReceiptForScope(transaction, operationalScope(world.tenantId)).receipt({
              attempt,
              handoff: current,
            }),
          );
        // nothing is recorded yet: the owner has no receipt, which Privacy reads as unavailable, never as a result
        expect(Option.isNone(yield* receiptOf(handoff))).toBe(true);
        const recorded = yield* world.database.inTenant(world.tenantId, (transaction) =>
          recordPrivacyMeasureHandoff(transaction, handoff, invocation),
        );
        expect(recorded.outcome).toBe('RECORDED');
        const dataBefore = yield* ownerDataHash(world);
        const received = Option.getOrThrow(yield* receiptOf(handoff));
        expect(received.handoffFingerprint).toBe(recorded.fingerprint);
        expect(received.outcome).toMatchObject({ reason: 'AWAITING_HUMAN_CONFIRMED_OWNER_ACTION', status: 'RECEIVED' });
        expect(received.outcome.remainingResourceRefs).toEqual(targets);
        expect(
          validateOwnerExecutionAuthorityResult(
            handoff,
            { attempt: 1, measureId: handoff.measureId, taskId: handoff.taskId },
            {
              authorityRef: 'communications.core.api.privacy-owner-execution-outcome',
              contentScopeRefs: handoff.contentScopeRefs,
              evidenceRefs: received.outcome.evidenceRefs,
              outcome: received.outcome,
              receiptRef: received.outcome.outcomeId,
              resourceRefs: handoff.resourceRefs,
              subjectRef: handoff.subjectRef,
              tenantId: handoff.tenantId,
            },
          ),
        ).toBeUndefined();
        // an idempotent redelivery records nothing new
        const again = yield* world.database.inTenant(world.tenantId, (transaction) =>
          recordPrivacyMeasureHandoff(transaction, handoff, invocation),
        );
        expect(again.outcome).toBe('EXISTS');
        const confirm = (payload: RecordOwnerExecutionEvidencePayload) =>
          world.database.inTenant(world.tenantId, (transaction) =>
            ownerExecutionEvidenceFor(transaction).record(payload, invocation),
          );
        const [first] = targets;
        yield* confirm(
          evidenceOf(handoff, recorded.fingerprint, { evidenceRef: 'FICTIONAL-evidence-0', phase: 'IN_PROGRESS' }),
        );
        expect(Option.getOrThrow(yield* receiptOf(handoff)).outcome.status).toBe('IN_PROGRESS');
        const partial = yield* confirm(
          evidenceOf(handoff, recorded.fingerprint, {
            evidenceRef: 'FICTIONAL-evidence-1',
            results: [{ contentRef: first ?? '', result: 'ANONYMIZED' }],
          }),
        );
        expect(partial).toEqual({
          destructiveActionPerformed: false,
          evidenceRef: 'FICTIONAL-evidence-1',
          outcome: 'RECORDED',
        });
        const partialReceipt = Option.getOrThrow(yield* receiptOf(handoff)).outcome;
        expect(partialReceipt.status).toBe('PARTIAL');
        expect(partialReceipt.includedResourceRefs).toEqual([first]);
        // a result for one part never closes the rest
        expect(partialReceipt.remainingResourceRefs).toEqual(targets.slice(1));
        yield* confirm(
          evidenceOf(handoff, recorded.fingerprint, {
            evidenceRef: 'FICTIONAL-evidence-2',
            results: targets.map((contentRef) => ({ contentRef, result: 'ANONYMIZED' as const })),
          }),
        );
        const done = Option.getOrThrow(yield* receiptOf(handoff)).outcome;
        expect(done.status).toBe('SUCCEEDED');
        expect(done.remainingResourceRefs).toEqual([]);
        // recording evidence and reading receipts never touched any owner business data
        expect(yield* ownerDataHash(world)).toBe(dataBefore);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('refuses a forged, foreign or contradicting confirmation and never lets it reach a result', () =>
    Effect.gen(function* forgedEvidence() {
      const { targets, world } = yield* measureWorld;
      const handoff = handoffOf(world.tenantId, targets, { dispositionDecision: 'DELETE', kind: 'DELETE' });
      const invocation = yield* nextId;
      const recorded = yield* world.database.inTenant(world.tenantId, (transaction) =>
        recordPrivacyMeasureHandoff(transaction, handoff, invocation),
      );
      const confirm = (payload: RecordOwnerExecutionEvidencePayload) =>
        world.database
          .inTenant(world.tenantId, (transaction) => ownerExecutionEvidenceFor(transaction).record(payload, invocation))
          .pipe(
            Effect.map(() => 'RECORDED' as const),
            Effect.catchTag('OwnerExecutionEvidenceRejected', (rejected) => Effect.succeed(rejected.refusal)),
          );
      const [first] = targets;
      const removed = [{ contentRef: first ?? '', result: 'REMOVED' as const }];
      // another handoff than the recorded one, a target outside the approval and another measure are all refused by name
      expect(yield* confirm(evidenceOf(handoff, 'b'.repeat(64), { results: removed }))).toBe(
        'HANDOFF_FINGERPRINT_DOES_NOT_MATCH_THE_RECORDED_HANDOFF',
      );
      expect(
        yield* confirm(
          evidenceOf(handoff, recorded.fingerprint, {
            results: [{ contentRef: 'communications.core.intent:foreign', result: 'REMOVED' }],
          }),
        ),
      ).toBe('RESULT_NAMES_CONTENT_OUTSIDE_THE_APPROVED_TARGETS');
      expect(
        yield* confirm(
          evidenceOf(handoff, recorded.fingerprint, { idempotencyKey: 'FICTIONAL-unknown-measure', results: removed }),
        ),
      ).toBe('NO_HANDOFF_RECORDED_FOR_THIS_MEASURE');
      // a claimed removal while the owner still FINDS the data is a contradiction only reconciliation settles, never a result
      yield* world.database.inTenant(world.tenantId, (transaction) =>
        ownerExecutionEvidenceFor(transaction).record(
          evidenceOf(handoff, recorded.fingerprint, { results: removed }),
          invocation,
        ),
      );
      const receipt = Option.getOrThrow(
        yield* world.database.inTenant(world.tenantId, (transaction) =>
          privacyOwnerExecutionReceiptForScope(transaction, operationalScope(world.tenantId)).receipt({
            attempt: 1,
            handoff,
          }),
        ),
      );
      expect(receipt.outcome).toMatchObject({
        reason: 'CLAIMED_REMOVAL_CONTRADICTED_BY_CURRENT_COVERAGE',
        status: 'INDETERMINATE',
      });
      expect(receipt.outcome.includedResourceRefs).toEqual([]);
      // the same measure identity with another scope is a conflict, answered as a rejection that Privacy sees as a mismatch
      const rescoped = handoffOf(world.tenantId, targets, {
        dispositionDecision: 'DELETE',
        kind: 'DELETE',
        ownerScope: { ...ownerScope, controllerRef: 'another-controller' },
      });
      const conflict = Option.getOrThrow(
        yield* world.database.inTenant(world.tenantId, (transaction) =>
          privacyOwnerExecutionReceiptForScope(transaction, operationalScope(world.tenantId)).receipt({
            attempt: 1,
            handoff: rescoped,
          }),
        ),
      );
      expect(conflict.handoffFingerprint).toBe(recorded.fingerprint);
      expect(conflict.outcome.status).toBe('BUSINESS_REJECTED');
      // a handoff of another Tenant is never answered
      const foreign = handoffOf('00000000-0000-4000-8000-0000000000ff', targets);
      expect(
        Option.isNone(
          yield* world.database.inTenant(world.tenantId, (transaction) =>
            privacyOwnerExecutionReceiptForScope(transaction, operationalScope(world.tenantId)).receipt({
              attempt: 1,
              handoff: foreign,
            }),
          ),
        ),
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    'reports a failure before any mutation as TECHNICAL_FAILED and a handoff of the same identity with another scope as a conflict',
    () =>
      Effect.gen(function* technicalFailure() {
        const { targets, world } = yield* measureWorld;
        const handoff = handoffOf(world.tenantId, targets);
        const invocation = yield* nextId;
        const recorded = yield* world.database.inTenant(world.tenantId, (transaction) =>
          recordPrivacyMeasureHandoff(transaction, handoff, invocation),
        );
        yield* world.database.inTenant(world.tenantId, (transaction) =>
          ownerExecutionEvidenceFor(transaction).record(
            evidenceOf(handoff, recorded.fingerprint, {
              results: targets.map((contentRef) => ({ contentRef, result: 'FAILED_BEFORE_ANY_MUTATION' as const })),
            }),
            invocation,
          ),
        );
        const receipt = Option.getOrThrow(
          yield* world.database.inTenant(world.tenantId, (transaction) =>
            privacyOwnerExecutionReceiptForScope(transaction, operationalScope(world.tenantId)).receipt({
              attempt: 1,
              handoff,
            }),
          ),
        );
        expect(receipt.outcome.status).toBe('TECHNICAL_FAILED');
        const conflicting = yield* world.database.inTenant(world.tenantId, (transaction) =>
          recordPrivacyMeasureHandoff(
            transaction,
            handoffOf(world.tenantId, targets, { ownerScope: { ...ownerScope, controllerRef: 'another-controller' } }),
            invocation,
          ),
        );
        expect(conflicting.outcome).toBe('CONFLICT');
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});
