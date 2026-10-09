import { DateTime, Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  CompensateCurrencySupportRecoveryPayloadSchema,
  CompensateCurrencySupportRecoveryResultSchema,
  CurrencySupportRecoveryCompensationConflict,
  applyCurrencySupportRecoveryCompensation,
  compensateCurrencySupportRecoveryAction,
  handleCompensateCurrencySupportRecovery,
} from '../../src/actions/compensate-currency-support-recovery.action.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const actorPrincipalId = '22222222-2222-4222-8222-222222222222';
const committedActionInvocationId = '33333333-3333-4333-8333-333333333333';
const compensationActionInvocationId = '44444444-4444-4444-8444-444444444444';
const supportId = '55555555-5555-4555-8555-555555555555';
const supportRevisionId = '66666666-6666-4666-8666-666666666666';
const trustedOperationAt = DateTime.toDateUtc(DateTime.makeUnsafe('2026-10-01T12:00:00.000Z'));
const payload = Schema.decodeSync(CompensateCurrencySupportRecoveryPayloadSchema)({
  committedActionInvocationId,
  reason: 'End the exact committed recovery state through a new governed transition.',
});
const result = Schema.decodeSync(CompensateCurrencySupportRecoveryResultSchema)({
  absentFrom: '2026-10-01T12:00:00.000Z',
  committedActionInvocationId,
  committedGeneration: 1,
  committedScheduleRevision: 1,
  committedSupportRevisionRef: {
    moduleId: 'commerce.pricing' as const,
    resourceId: supportRevisionId,
    resourceType: 'commerce.pricing.currency-support-revision' as const,
    supportRootId: supportId,
    tenantId,
  },
  compensationScheduleRevision: 2,
  outcome: 'CURRENCY_SUPPORT_RECOVERY_COMPENSATED' as const,
  supportRootRef: {
    moduleId: 'commerce.pricing' as const,
    resourceId: supportId,
    resourceType: 'commerce.pricing.currency-support' as const,
    tenantId,
  },
});

describe('Compensate Currency Support recovery Action', () => {
  it('is a distinct explicitly provisioned Tenant Action and accepts no replacement authority', () => {
    expect(compensateCurrencySupportRecoveryAction.descriptor).toMatchObject({
      actionKey: 'commerce.pricing.compensate-currency-support-recovery',
      idempotency: 'required',
      legalEntityScope: 'forbidden',
      schemaVersion: '1',
    });
    const decode = Schema.decodeUnknownSync(CompensateCurrencySupportRecoveryPayloadSchema, {
      onExcessProperty: 'error',
    });
    for (const forbidden of [{ legacyAuthority: 'RESTORE' }, { supportedCurrencies: ['CZK'] }, { tenantId }]) {
      expect(() => decode({ ...payload, ...forbidden })).toThrow();
    }
  });

  it.effect('binds compensation to the trusted Action identity and exact committed result', () =>
    Effect.gen(function* exactCommittedResult() {
      const commands: unknown[] = [];
      const applied = yield* applyCurrencySupportRecoveryCompensation(
        payload,
        {
          actionInvocationId: compensationActionInvocationId,
          actorPrincipalId,
          tenantId,
          trustedOperationAt,
        },
        (command) => {
          commands.push(command);
          return Effect.succeed({ outcome: 'COMPENSATED' as const, result });
        },
      );

      expect(applied).toEqual(result);
      expect(commands).toEqual([
        {
          actingPrincipalId: actorPrincipalId,
          actionInvocationId: compensationActionInvocationId,
          committedActionInvocationId,
          reason: payload.reason,
          tenantId,
          trustedOperationAt,
        },
      ]);
    }),
  );

  it.effect('fails closed on stale canonical state and never asks persistence to restore legacy writes', () =>
    Effect.gen(function* staleCanonicalState() {
      const failure = yield* applyCurrencySupportRecoveryCompensation(
        payload,
        {
          actionInvocationId: compensationActionInvocationId,
          actorPrincipalId,
          tenantId,
          trustedOperationAt,
        },
        () => Effect.succeed({ outcome: 'CONFLICT' as const, reason: 'CANONICAL_STATE_CHANGED' as const }),
      ).pipe(Effect.flip);

      expect(failure).toBeInstanceOf(CurrencySupportRecoveryCompensationConflict);
      expect(failure).toMatchObject({
        code: 'currency_support_recovery_compensation_conflict',
        reason: 'CANONICAL_STATE_CHANGED',
      });
    }),
  );

  it.effect('records the governed transition and its exact canonical target', () =>
    Effect.gen(function* governedActionEvidence() {
      let audit: unknown;
      let access: unknown;
      let command: unknown;
      const actionResult = yield* handleCompensateCurrencySupportRecovery(payload, {
        actionInvocationId: compensationActionInvocationId,
        addDomainEvent: () => Effect.die('unused'),
        addOutboxMessage: () => Effect.die('unused'),
        compositionRevision: 'a'.repeat(64),
        recordAuditEvidence: (evidence) => {
          audit = evidence;
          return Effect.void;
        },
        recordDataAccess: (evidence) => {
          access = evidence;
          return Effect.void;
        },
        scope: {
          authBindingId: '77777777-7777-4777-8777-777777777777',
          authContextRef: 'session:currency-support-recovery-compensation',
          authMethod: 'session',
          correlationId: 'currency-support-recovery-compensation-unit',
          principalId: actorPrincipalId,
          tenantId,
        },
        services: {
          compensateRecovery: (input) => {
            command = input;
            return Effect.succeed({ outcome: 'COMPENSATED' as const, result });
          },
        },
      });

      expect(actionResult).toEqual(result);
      expect(command).toMatchObject({
        actingPrincipalId: actorPrincipalId,
        actionInvocationId: compensationActionInvocationId,
        committedActionInvocationId,
        tenantId,
      });
      expect(audit).toEqual(payload);
      expect(access).toMatchObject({
        accessKind: 'read',
        resultCount: 1,
        targetResourceId: supportId,
        targetResourceType: 'commerce.pricing.currency-support',
      });
    }),
  );
});
