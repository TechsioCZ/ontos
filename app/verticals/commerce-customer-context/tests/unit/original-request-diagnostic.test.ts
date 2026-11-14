import {
  ActionExecutionResolutionSchema,
  ActionPayloadValidationError,
  scopedRoutineInvokerFromTransaction,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import { computeActionRequestHash } from '@app/core-runtime/actions/runtime-wiring';
import { Effect, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { commercePortalAuthEnrollmentIntent } from '../../api/portal-auth/enrollment/intent.ts';
import { StartPortalEnrollmentPayloadSchema } from '../../shared/actions/start-portal-enrollment.ts';
import {
  OriginalEnrollmentReceiptRead,
  readOriginalEnrollmentRequest,
} from '../../src/enrollment/attempts/original-request-diagnostic.ts';
import { EnrollmentLegalEntityIdSchema } from '../../shared/enrollment-contracts.ts';
import { CommerceEnrollmentOwnerTransactionRunner } from '../../src/enrollment/orchestration/owner-transition-production.ts';

const scope = {
  legalEntityId: '10000000-0000-4000-8000-000000000002',
  principalId: '10000000-0000-4000-8000-000000000003',
  tenantId: '10000000-0000-4000-8000-000000000001',
};
const principal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  ...scope,
  authBindingId: '10000000-0000-4000-8000-000000000004',
  authContextRef: 'better-auth-api-key:original-test',
  authenticationNamespaceId: 'core-identity',
  authMethod: 'api_key',
});
const invocationId = '10000000-0000-4000-8000-000000000005';
const attemptId = '10000000-0000-4000-8000-000000000006';

const fixture = Effect.gen(function* fixture() {
  const originalIntent = yield* commercePortalAuthEnrollmentIntent({
    displayName: 'Original local fixture',
    email: 'original@example.test',
    journey: 'RETAIL_SELF_ENROLLMENT',
    password: Redacted.make('fixture-credential-not-used'),
    sellingLegalEntityId: Schema.decodeSync(EnrollmentLegalEntityIdSchema)(scope.legalEntityId),
  });
  const request = {
    expectedScope: scope,
    expectedStartInvocationId: invocationId,
    originalIntent,
    requestId: '10000000-0000-4000-8000-000000000007',
  };
  const normalizedPayload = yield* Schema.encodeEffect(StartPortalEnrollmentPayloadSchema)(originalIntent);
  const hash = computeActionRequestHash({
    actionKey: 'commerce.customer-context.start-portal-enrollment',
    normalizedPayload,
    owningModuleKey: 'commerce.customer-context',
    principal,
    schemaVersion: '1',
    target: {},
  });
  let ownerReads = 0;
  let receiptReads = 0;
  const receipt: typeof OriginalEnrollmentReceiptRead.Service = {
    resolveActionExecution: (input) => {
      receiptReads += 1;
      expect(input.principal).toEqual(principal);
      expect(input.idempotencyKey).toBe(`storefront-enrollment:${request.requestId}`);
      return input.expectedRequestHash === hash
        ? Schema.decodeUnknownEffect(ActionExecutionResolutionSchema)({
            actionKey: 'commerce.customer-context.start-portal-enrollment',
            invocationId,
            retryCommand: false,
            state: 'COMMITTED',
          }).pipe(Effect.orDie)
        : Effect.fail(
            new ActionPayloadValidationError({
              code: 'action_payload_invalid',
              reason: 'The original Action request could not be matched',
            }),
          );
    },
  };
  const runner: typeof CommerceEnrollmentOwnerTransactionRunner.Service = {
    run: (actualScope, operation) => {
      ownerReads += 1;
      expect(actualScope).toEqual({ legalEntityId: scope.legalEntityId, tenantId: scope.tenantId });
      return operation(
        scopedRoutineInvokerFromTransaction(
          () => Effect.succeed([{ portal_enrollment_attempt_id: attemptId }]),
          actualScope,
        ),
      );
    },
    runWorker: () => Effect.die('No worker/sweep capability is admitted'),
  };
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(OriginalEnrollmentReceiptRead, receipt),
      Effect.provideService(CommerceEnrollmentOwnerTransactionRunner, runner),
    );
  return { counts: () => ({ ownerReads, receiptReads }), provide, receipt, request, runner };
});

it.effect('matches the original start codec/hash before one scoped owner read, with no provider service', () =>
  Effect.gen(function* success() {
    const f = yield* fixture;
    expect(yield* f.provide(readOriginalEnrollmentRequest(f.request, principal))).toEqual({
      portalEnrollmentAttemptId: attemptId,
    });
    expect(f.counts()).toEqual({ ownerReads: 1, receiptReads: 1 });
  }),
);

it.effect('wrong current caller, tenant or company fails before receipt or owner lookup', () =>
  Effect.gen(function* wrongCaller() {
    const f = yield* fixture;
    for (const field of ['principalId', 'tenantId', 'legalEntityId'] as const) {
      const foreign = { ...principal, [field]: '20000000-0000-4000-8000-000000000001' };
      const error = yield* f.provide(readOriginalEnrollmentRequest(f.request, foreign)).pipe(Effect.flip);
      expect(error.code).toBe('ORIGINAL_REQUEST_NOT_AVAILABLE');
    }
    expect(f.counts()).toEqual({ ownerReads: 0, receiptReads: 0 });
  }),
);

it.effect('alternate intent or digest under the original key cannot disclose another Attempt', () =>
  Effect.gen(function* wrongIntent() {
    const f = yield* fixture;
    for (const originalIntent of [
      { ...f.request.originalIntent, intentDigest: 'e'.repeat(64) },
      { ...f.request.originalIntent, intentKey: 'another-intent' },
    ]) {
      const error = yield* f
        .provide(readOriginalEnrollmentRequest({ ...f.request, originalIntent }, principal))
        .pipe(Effect.flip);
      expect(error.code).toBe('ORIGINAL_REQUEST_NOT_AVAILABLE');
      expect(Object.hasOwn(error, 'cause')).toBe(false);
    }
    expect(f.counts()).toEqual({ ownerReads: 0, receiptReads: 2 });
  }),
);

it.effect('non-COMMITTED or a different original invocation cannot reach the owner', () =>
  Effect.gen(function* noReceipt() {
    const f = yield* fixture;
    for (const resolution of [
      { retryCommand: true, state: 'NOT_STARTED' },
      { invocationId, retryCommand: true, state: 'RETRYABLE' },
      { invocationId, retryCommand: false, state: 'RUNNING' },
      { invocationId, retryCommand: false, state: 'REJECTED' },
      {
        actionKey: 'commerce.customer-context.start-portal-enrollment',
        invocationId: attemptId,
        retryCommand: false,
        state: 'COMMITTED',
      },
    ]) {
      const effect = readOriginalEnrollmentRequest(f.request, principal).pipe(
        Effect.provideService(OriginalEnrollmentReceiptRead, {
          resolveActionExecution: () =>
            Schema.decodeUnknownEffect(ActionExecutionResolutionSchema)(resolution).pipe(Effect.orDie),
        }),
        Effect.provideService(CommerceEnrollmentOwnerTransactionRunner, f.runner),
      );
      expect((yield* effect.pipe(Effect.flip)).code).toBe('ORIGINAL_REQUEST_NOT_AVAILABLE');
    }
    expect(f.counts().ownerReads).toBe(0);
  }),
);

it.effect('credential fields and non-api-key callers are refused without exposing submitted values', () =>
  Effect.gen(function* noCredential() {
    const f = yield* fixture;
    const invalidRequest = { ...f.request, password: Redacted.make('test-rejected-credential') };
    const error = yield* f.provide(readOriginalEnrollmentRequest(invalidRequest, principal)).pipe(Effect.flip);
    expect(error.code).toBe('ORIGINAL_REQUEST_NOT_AVAILABLE');
    expect(Object.hasOwn(error, 'cause')).toBe(false);
    expect(
      (yield* f
        .provide(readOriginalEnrollmentRequest(f.request, { ...principal, authMethod: 'session' }))
        .pipe(Effect.flip)).code,
    ).toBe('ORIGINAL_REQUEST_NOT_AVAILABLE');
    expect(f.counts()).toEqual({ ownerReads: 0, receiptReads: 0 });
  }),
);
