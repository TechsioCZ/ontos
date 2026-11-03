import { readFileSync } from 'node:fs';
import type { OperationalScope, ReadHandlerContext } from '@app/core-runtime';
import { ReadHandlerUnavailable, ReadPermissionDenied } from '@app/core-runtime';
import {
  MarketAffectedUseVerifiedSchema,
  MarketRetirementReservationRecoveryRequestSchema,
  MarketRetirementReservationRecoveryResponseSchema,
  ReserveMarketRetirementPayloadSchema,
} from '@app/customer-market-retirement-contracts';
import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  handleMarketRetirementReservationRecovery,
  marketRetirementReservationRecoveryRead,
} from '../../src/api/market-retirement-reservation-recovery.read.ts';
import {
  marketRetirementReservationForTransaction,
  marketRetirementReservationRecoveryForInvoker,
} from '../../src/persistence/market-retirement-persistence.ts';
import {
  MarketRetirementAssessmentStaleError,
  marketRetirementReservationServiceFromAuthorities,
} from '../../src/services/market-retirement-reservation.service.ts';
import type { MarketRetirementReservationRecoveryRepository } from '../../src/services/market-retirement-reservation-recovery.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const principalId = '22222222-2222-4222-8222-222222222222';
const sourceActionInvocationId = '33333333-3333-4333-8333-333333333333';
const request = Schema.decodeUnknownSync(MarketRetirementReservationRecoveryRequestSchema)({
  marketRef: {
    moduleId: 'commerce.market-catalog',
    resourceId: 'market-cz',
    resourceType: 'commerce.market-catalog.market',
    tenantId,
  },
  sourceActionInvocationId,
  tenantId,
});
const evidence = {
  completenessEvidence: {
    observedAt: '2026-09-01T00:00:00.000Z',
    ownerRevision: 'original-revision',
    scope: { kind: 'EXACT_PREDICATE', predicateRef: 'original-predicate' },
  },
  currentness: 'CURRENT',
  digest: 'a'.repeat(64),
  generation: 'original-generation',
  ownerRevision: 'original-revision',
  sourceId: 'application-composition:commerce.cart:UNIMPLEMENTED',
};
const encodedOriginalAssessment = {
  assessmentDigest: 'a'.repeat(64),
  evaluatedAt: '2026-09-01T00:00:00.000Z',
  liveBlockingReferences: { bootstrapDefaults: [], currentProposals: [] },
  marketRef: request.marketRef,
  marketRevision: 7,
  observedAt: '2026-09-01T00:00:00.000Z',
  outcome: 'VERIFIED',
  retainedHistoryReferences: [
    {
      kind: 'RETAINED_HISTORY',
      marketRef: request.marketRef,
      marketRevision: 7,
      ownerResourceRef: {
        moduleId: 'commerce.customer-context',
        resourceId: 'retained-policy',
        resourceType: 'commerce.customer-context.market-bootstrap-policy',
        tenantId,
      },
      ownerResourceRevision: 'retained-revision-3',
    },
  ],
  sourceEvidence: [evidence],
  tenantId,
};
const originalAssessment = Schema.decodeUnknownSync(MarketAffectedUseVerifiedSchema)(encodedOriginalAssessment);

const encodedReceipt = {
  ...request,
  actionInvocationId: '44444444-4444-4444-8444-444444444444',
  assessmentDigest: 'a'.repeat(64),
  compositionRevision: 'b'.repeat(64),
  evaluatedAt: '2026-09-01T00:00:00.000Z',
  lifecycle: 'COMMITTED',
  marketRevision: 7,
  originalActorPrincipalId: principalId,
  originalAssessment: encodedOriginalAssessment,
  originalLifecycle: 'RESERVED',
  originalReason: 'Original retirement reason',
  originalReservationVersion: 1,
  outcome: 'FOUND',
  releaseGuardHash: 'c'.repeat(64),
  reservationToken: '55555555-5555-4555-8555-555555555555',
  reservationVersion: 2,
  sourceEvidence: [evidence],
};
const receipt = Schema.decodeUnknownSync(MarketRetirementReservationRecoveryResponseSchema)(encodedReceipt);
const scope: OperationalScope = {
  authMethod: 'system',
  correlationId: 'recover-original',
  legalEntityId: '66666666-6666-4666-8666-666666666666',
  principalId,
  tenantId,
};
const context = (
  services: MarketRetirementReservationRecoveryRepository,
): ReadHandlerContext<MarketRetirementReservationRecoveryRepository> => ({
  readKey: marketRetirementReservationRecoveryRead.descriptor.readKey,
  scope,
  services,
});

it.effect('retains original evidence and reservation version independently from the terminal lifecycle', () =>
  Effect.gen(function* retainsOriginalEvidence() {
    const calls: unknown[] = [];
    const repository = marketRetirementReservationRecoveryForInvoker(
      {
        invoke: (routine, values) => {
          calls.push({ key: routine.routineKey, values });
          return Schema.decodeUnknownEffect(routine.resultSchema)({ result: encodedReceipt }).pipe(
            Effect.map((row) => [row]),
            Effect.orDie,
          );
        },
      },
      principalId,
    );
    const result = yield* handleMarketRetirementReservationRecovery(request, context(repository));
    expect(result.result).toEqual(receipt);
    expect(result.evidence.resultCount).toBe(1);
    expect(calls).toEqual([
      { key: 'market-retirement.recover-reservation', values: [principalId, sourceActionInvocationId, 'market-cz'] },
    ]);
    if (result.result.outcome === 'FOUND') {
      expect(result.result.originalReservationVersion).toBe(1);
      expect(result.result.reservationVersion).toBe(2);
      expect(result.result.sourceEvidence[0]?.sourceId).toBe(evidence.sourceId);
      expect('releaseProof' in result.result).toBe(false);
      expect('currentness' in result.result).toBe(false);
    }
  }),
);

it.effect('rejects cross-Tenant input before the owner lookup', () =>
  Effect.gen(function* rejectsCrossTenant() {
    let calls = 0;
    const services = {
      recover: () => {
        calls += 1;
        return Effect.succeed(receipt);
      },
    };
    const failure = yield* handleMarketRetirementReservationRecovery(
      { ...request, tenantId: '77777777-7777-4777-8777-777777777777' },
      context(services),
    ).pipe(Effect.flip);
    expect(Schema.is(ReadPermissionDenied)(failure)).toBe(true);
    expect(calls).toBe(0);
  }),
);

it.effect('rejects a response from another original actor or invocation', () =>
  Effect.gen(function* rejectsOtherOriginal() {
    for (const changed of [
      { originalActorPrincipalId: '77777777-7777-4777-8777-777777777777' },
      { sourceActionInvocationId: '77777777-7777-4777-8777-777777777777' },
    ]) {
      const other = Schema.decodeUnknownSync(MarketRetirementReservationRecoveryResponseSchema)({
        ...encodedReceipt,
        ...changed,
      });
      const failure = yield* handleMarketRetirementReservationRecovery(
        request,
        context({ recover: () => Effect.succeed(other) }),
      ).pipe(Effect.flip);
      expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
    }
  }),
);

it.effect('returns exact NOT_FOUND without inferring retirement safety', () =>
  Effect.gen(function* returnsExactMissing() {
    const missing = { ...request, outcome: 'NOT_FOUND' as const };
    const result = yield* handleMarketRetirementReservationRecovery(
      request,
      context({ recover: () => Effect.succeed(missing) }),
    );
    expect(result).toEqual({ evidence: { resultCount: 0 }, result: missing });
  }),
);

it('requires a guard for new source binding while retaining unbound reservation input', () => {
  const payload = {
    assessmentDigest: encodedReceipt.assessmentDigest,
    evaluatedAt: encodedReceipt.evaluatedAt,
    marketRef: request.marketRef,
    marketRevision: 7,
    operation: 'RESERVE',
    reason: 'Original retirement reason',
    sourceEvidence: [evidence],
    tenantId,
  };
  const decode = Schema.decodeUnknownSync(ReserveMarketRetirementPayloadSchema, { onExcessProperty: 'error' });
  expect(decode(payload).operation).toBe('RESERVE');
  expect(() => decode({ ...payload, sourceActionInvocationId })).toThrow();
  expect(
    decode({ ...payload, releaseGuardHash: encodedReceipt.releaseGuardHash, sourceActionInvocationId }).operation,
  ).toBe('RESERVE');
  expect(() =>
    Schema.decodeUnknownSync(MarketRetirementReservationRecoveryRequestSchema, { onExcessProperty: 'error' })({
      ...request,
      originalActorPrincipalId: principalId,
    }),
  ).toThrow();
});

it('generates immutable provenance and proof-gated release SQL without rewriting historical evidence', () => {
  const migration = readFileSync(
    new URL('../../drizzle/20261031134005_market-retirement-source-recovery/migration.sql', import.meta.url),
    'utf-8',
  );
  expect(migration).toContain('original_actor_principal_id');
  expect(migration).toContain('NEW.original_assessment');
  expect(migration).toContain('OLD.original_assessment');
  expect(migration).toContain("v_original_assessment->'sourceEvidence' IS DISTINCT FROM v_source_evidence");
  expect(migration).toContain('original assessment differs from verified complete owner assessment');
  // Source-only defense pending PostgreSQL execution: NULL must not enter a default release branch.
  expect(migration).toContain("v_operation IS NULL OR v_operation NOT IN ('RESERVE', 'COMMIT', 'RELEASE')");
  expect(migration).toContain("ELSIF v_operation IN ('COMMIT', 'RELEASE') THEN");
  expect(migration).toContain("ELSIF v_operation = 'RELEASE' THEN");
  expect(migration).toContain("RAISE EXCEPTION 'invalid Market retirement completion operation'");
  expect(migration).toContain('v_existing.original_actor_principal_id IS DISTINCT FROM v_actor_principal_id');
  expect(migration).toContain(
    "encode(sha256(convert_to(v_release_proof, 'UTF8')), 'hex') IS DISTINCT FROM v_existing.release_guard_hash",
  );
  expect(migration).toContain("'originalReservationVersion', v_reservation.original_reservation_version");
  expect(migration).toContain("'application-composition:commerce.cart:UNIMPLEMENTED'");
  expect(migration).toContain("'application-composition:commerce.order:UNIMPLEMENTED'");
  expect(migration).not.toContain('FROM core.action_invocations');
});

it.effect('captures the independently verified full snapshot and encodes DateTime evidence before persistence', () =>
  Effect.gen(function* capturesOriginalAssessment() {
    const persisted: unknown[] = [];
    const reservationResult = {
      assessmentDigest: encodedReceipt.assessmentDigest,
      lifecycle: 'RESERVED',
      marketRef: request.marketRef,
      marketRevision: 7,
      reservationToken: encodedReceipt.reservationToken,
      reservationVersion: 1,
      tenantId,
    };
    const repository = marketRetirementReservationForTransaction({
      invoke: (routine, values) => {
        persisted.push(values);
        return Schema.decodeUnknownEffect(routine.resultSchema)({ result: reservationResult }).pipe(
          Effect.map((row) => [row]),
          Effect.orDie,
        );
      },
    });
    const service = marketRetirementReservationServiceFromAuthorities(
      { assess: () => Effect.succeed(originalAssessment) },
      repository,
      Effect.succeed(DateTime.toEpochMillis(DateTime.makeUnsafe(encodedReceipt.evaluatedAt))),
    );
    const payload = Schema.decodeUnknownSync(ReserveMarketRetirementPayloadSchema)({
      assessmentDigest: encodedReceipt.assessmentDigest,
      evaluatedAt: encodedReceipt.evaluatedAt,
      marketRef: request.marketRef,
      marketRevision: 7,
      operation: 'RESERVE',
      reason: encodedReceipt.originalReason,
      releaseGuardHash: encodedReceipt.releaseGuardHash,
      sourceActionInvocationId,
      sourceEvidence: [evidence],
      tenantId,
    });
    yield* service.execute(payload, {
      actionInvocationId: encodedReceipt.actionInvocationId,
      actorPrincipalId: principalId,
      compositionRevision: encodedReceipt.compositionRevision,
    });
    expect(persisted).toEqual([
      [
        {
          ...Schema.encodeSync(ReserveMarketRetirementPayloadSchema)(payload),
          actionInvocationId: encodedReceipt.actionInvocationId,
          actorPrincipalId: principalId,
          compositionRevision: encodedReceipt.compositionRevision,
          originalAssessment: Schema.encodeSync(MarketAffectedUseVerifiedSchema)(originalAssessment),
        },
      ],
    ]);
    const legacyPayload = Schema.decodeUnknownSync(ReserveMarketRetirementPayloadSchema)({
      assessmentDigest: encodedReceipt.assessmentDigest,
      evaluatedAt: encodedReceipt.evaluatedAt,
      marketRef: request.marketRef,
      marketRevision: 7,
      operation: 'RESERVE',
      reason: encodedReceipt.originalReason,
      sourceEvidence: [evidence],
      tenantId,
    });
    yield* service.execute(legacyPayload, {
      actionInvocationId: encodedReceipt.actionInvocationId,
      actorPrincipalId: principalId,
    });
    expect(persisted[1]).toEqual([
      {
        ...Schema.encodeSync(ReserveMarketRetirementPayloadSchema)(legacyPayload),
        actionInvocationId: encodedReceipt.actionInvocationId,
        actorPrincipalId: principalId,
      },
    ]);
    // Public callers cannot inject even a correctly shaped original snapshot.
    expect(() =>
      Schema.decodeUnknownSync(ReserveMarketRetirementPayloadSchema, { onExcessProperty: 'error' })({
        ...Schema.encodeSync(ReserveMarketRetirementPayloadSchema)(payload),
        originalAssessment: encodedOriginalAssessment,
      }),
    ).toThrow();
  }),
);

it.effect('rejects a changed independently assessed digest before persisting an original receipt', () =>
  Effect.gen(function* refusesChangedOriginalAssessment() {
    let persisted = false;
    const payload = Schema.decodeUnknownSync(ReserveMarketRetirementPayloadSchema)({
      assessmentDigest: encodedReceipt.assessmentDigest,
      evaluatedAt: encodedReceipt.evaluatedAt,
      marketRef: request.marketRef,
      marketRevision: 7,
      operation: 'RESERVE',
      reason: encodedReceipt.originalReason,
      releaseGuardHash: encodedReceipt.releaseGuardHash,
      sourceActionInvocationId,
      sourceEvidence: [evidence],
      tenantId,
    });
    const service = marketRetirementReservationServiceFromAuthorities(
      { assess: () => Effect.succeed({ ...originalAssessment, assessmentDigest: 'd'.repeat(64) }) },
      {
        execute: () => {
          persisted = true;
          return Effect.die('Mismatched evidence reached persistence');
        },
      },
    );
    const failure = yield* service
      .execute(payload, { actionInvocationId: encodedReceipt.actionInvocationId, actorPrincipalId: principalId })
      .pipe(Effect.flip);
    expect(Schema.is(MarketRetirementAssessmentStaleError)(failure)).toBe(true);
    expect(persisted).toBe(false);
  }),
);
