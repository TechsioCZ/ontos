import { describe, expect, it } from 'effect-rstest';
import { DateTime, Effect, Option, Ref, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import {
  PrivacyNoticeAuthorityFactSchema,
  RecordNoticeProvisionPayloadSchema,
  ConsentSelfServiceRequestSchema,
  TrustedOperationConsentAuthorityFactSchema,
} from '@app/consent-authority-contracts';
import type { ActionAuthorizationPreflightInput } from '@app/core-runtime';
import { ConsentSelfServiceAuthorizationError } from '../../shared/domain/privacy-consent-self-service.ts';
import {
  CommerceConsentAuthorityLookup,
  preparedCommerceConsentExecution,
} from '../../src/actions/commerce-consent-authority.ts';
import type {
  CommerceConsentAuthorityLookupService,
  PreparedCommerceConsentExecution,
} from '../../src/actions/commerce-consent-authority.ts';

const prepareExecution = (lookup: CommerceConsentAuthorityLookupService) =>
  preparedCommerceConsentExecution.pipe(Effect.provideService(CommerceConsentAuthorityLookup, lookup));

const tenantId = '00000000-0000-4000-8000-000000000001';
const principalId = '00000000-0000-4000-8000-000000000002';
const legalEntityId = '00000000-0000-4000-8000-000000000003';
const request = Schema.decodeUnknownSync(ConsentSelfServiceRequestSchema)({
  decision: 'GRANTED',
  noticeEvidenceRefs: ['notice-provision:one'],
  path: {
    credentialRef: 'session:one',
    kind: 'OPERATION_SCOPED',
    operation: 'CONSENT_WRITE',
    operationRef: 'request:one',
    requestRef: 'request:one',
    scopeRef: 'scope:one',
    subjectRef: {
      moduleId: 'privacy.core',
      resourceId: 'retail-party:one',
      resourceType: 'privacy.core.privacy-subject',
      tenantId,
    },
  },
  scope: {
    controllerRef: legalEntityId,
    materialDimensions: [{ kind: 'COMMUNICATION_CHANNEL', value: 'EMAIL' }],
    privacySubjectRef: {
      moduleId: 'privacy.core',
      resourceId: 'retail-party:one',
      resourceType: 'privacy.core.privacy-subject',
      tenantId,
    },
    processingPurposeRef: {
      moduleId: 'privacy.core',
      resourceId: 'purpose:one',
      resourceType: 'privacy.core.processing-purpose',
      tenantId,
    },
    purposeMeaning: 'Volitelné obchodní zprávy e-mailem',
    purposeVersionRef: 'purpose-version:one',
    scopeRef: 'scope:one',
  },
});
const input: ActionAuthorizationPreflightInput = {
  actionInvocationId: 'invocation:one',
  actionKey: 'privacy.core.consent-self-service',
  correlationId: 'correlation:one',
  payload: request,
  principal: {
    authBindingId: '00000000-0000-4000-8000-000000000004',
    authContextRef: 'api-key:commerce',
    authMethod: 'api_key',
    legalEntityId,
    principalId,
    tenantId,
  },
  scope: {
    authBindingId: '00000000-0000-4000-8000-000000000004',
    authContextRef: 'api-key:commerce',
    authMethod: 'api_key',
    correlationId: 'correlation:one',
    legalEntityId,
    principalId,
    tenantId,
  },
};
const fact = (now: DateTime.Utc) =>
  Schema.decodeUnknownSync(TrustedOperationConsentAuthorityFactSchema)({
    actorPrincipalRef: { principalId, tenantId },
    authorizedScope: request.scope,
    decisionReceipt: {
      acknowledgedAt: DateTime.formatIso(now),
      decision: request.decision,
      requestRef: request.path.requestRef,
    },
    evidenceRefs: ['session:one', 'enrollment:complete'],
    expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 10 })),
    kind: 'OPERATION_SCOPED',
    operation: request.path.operation,
    operationRef: request.path.operationRef,
    proofRef: 'session:one',
    scopeRef: request.path.scopeRef,
    status: 'CURRENT',
    subjectRef: request.path.subjectRef,
    verifiedAt: DateTime.formatIso(now),
  });
const unavailableNotice: CommerceConsentAuthorityLookupService['resolveNotice'] = (_input) =>
  Effect.fail(
    new ConsentSelfServiceAuthorizationError({
      code: 'AUTHORITY_UNAVAILABLE',
      reason: 'Notice not requested by this consent fixture',
    }),
  );

describe('Commerce consent authority preparation', () => {
  it.effect('prepares before transaction, preserves ordinary authorization, and consumes exactly once', () =>
    Effect.gen(function* consentAuthorityCase1() {
      const now = yield* DateTime.now;
      let reads = 0;
      const execution = yield* prepareExecution({
        resolve: () =>
          Effect.sync(() => {
            reads += 1;
            return fact(now);
          }),
        resolveNotice: unavailableNotice,
      });
      expect(yield* execution.preflight.prepare(input)).toEqual({ outcome: 'not_applicable' });
      expect(reads).toBe(1);
      const args = { credentialRef: 'session:one', now: DateTime.formatIso(now), request };
      expect(yield* execution.authority.ports.verifyOperationCredential(args)).toEqual(fact(now));
      expect(reads).toBe(1);
      expect((yield* Effect.exit(execution.authority.ports.verifyOperationCredential(args)))._tag).toBe('Failure');
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
  it.effect('never shares prepared evidence between concurrent native invocations', () =>
    Effect.gen(function* consentAuthorityCase2() {
      const now = yield* DateTime.now;
      const lookup = { resolve: () => Effect.succeed(fact(now)), resolveNotice: unavailableNotice };
      const first = yield* prepareExecution(lookup);
      const second = yield* prepareExecution(lookup);
      yield* first.preflight.prepare(input);
      expect(
        (yield* Effect.exit(
          second.authority.ports.verifyOperationCredential({
            credentialRef: 'session:one',
            now: DateTime.formatIso(now),
            request,
          }),
        ))._tag,
      ).toBe('Failure');
      first.clear();
      expect(
        (yield* Effect.exit(
          first.authority.ports.verifyOperationCredential({
            credentialRef: 'session:one',
            now: DateTime.formatIso(now),
            request,
          }),
        ))._tag,
      ).toBe('Failure');
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
  it.effect('rejects changed operation, decision, notice and scope rather than reusing a proof', () =>
    Effect.gen(function* consentAuthorityCase3() {
      const now = yield* DateTime.now;
      for (const changed of [
        { ...request, decision: 'WITHDRAWN' as const },
        { ...request, noticeEvidenceRefs: ['notice-provision:forged'] },
        { ...request, scope: { ...request.scope, purposeMeaning: 'Other purpose' } },
      ]) {
        const execution = yield* prepareExecution({
          resolve: () => Effect.succeed(fact(now)),
          resolveNotice: unavailableNotice,
        });
        yield* execution.preflight.prepare(input);
        expect(
          (yield* Effect.exit(
            execution.authority.ports.verifyOperationCredential({
              credentialRef: 'session:one',
              now: DateTime.formatIso(now),
              request: changed,
            }),
          ))._tag,
        ).toBe('Failure');
      }
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
  it.effect('denies unsupported profile/support paths without calling the owner', () =>
    Effect.gen(function* consentAuthorityCase4() {
      const now = yield* DateTime.now;
      let reads = 0;
      const execution = yield* prepareExecution({
        resolve: () =>
          Effect.sync(() => {
            reads += 1;
            return fact(now);
          }),
        resolveNotice: unavailableNotice,
      });
      for (const path of [
        {
          kind: 'CURRENT_PROFILE_BINDING',
          operation: 'CONSENT_WRITE',
          operationRef: 'request:one',
          profileRef: 'forged-profile',
          requestRef: 'request:one',
          scopeRef: 'scope:one',
          subjectRef: request.path.subjectRef,
        },
        {
          kind: 'SUPPORT_ASSISTED',
          operation: 'CONSENT_WRITE',
          operationRef: 'request:one',
          representationRef: 'forged-support',
          requestRef: 'request:one',
          scopeRef: 'scope:one',
          subjectRef: request.path.subjectRef,
          verificationRef: 'forged-verification',
        },
      ]) {
        expect(yield* execution.preflight.prepare({ ...input, payload: { ...request, path } })).toEqual({
          outcome: 'denied',
        });
      }
      expect(reads).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
  it.effect('denies conflicting actor, stale session proof and cross-tenant authority', () =>
    Effect.gen(function* consentAuthorityCase5() {
      const now = yield* DateTime.now;
      for (const changed of [
        { ...fact(now), actorPrincipalRef: { principalId: legalEntityId, tenantId } },
        { ...fact(now), status: 'REVOKED' as const },
        { ...fact(now), subjectRef: { ...request.path.subjectRef, tenantId: legalEntityId } },
        { ...fact(now), expiresAt: DateTime.formatIso(DateTime.subtract(now, { minutes: 1 })) },
      ]) {
        const execution = yield* prepareExecution({
          resolve: () => Effect.succeed(changed),
          resolveNotice: unavailableNotice,
        });
        expect(yield* execution.preflight.prepare(input)).toEqual({ outcome: 'denied' });
      }
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
  it.effect('fails closed on owner outage and leaves unrelated native Actions untouched', () =>
    Effect.gen(function* consentAuthorityCase6() {
      let reads = 0;
      const execution = yield* prepareExecution({
        resolve: () => {
          reads += 1;
          return Effect.fail(
            new ConsentSelfServiceAuthorizationError({ code: 'AUTHORITY_UNAVAILABLE', reason: 'Owner unavailable' }),
          );
        },
        resolveNotice: unavailableNotice,
      });
      expect(
        yield* execution.preflight.prepare({ ...input, actionKey: 'privacy.core.create-privacy-subject' }),
      ).toEqual({ outcome: 'not_applicable' });
      expect(reads).toBe(0);
      expect((yield* Effect.exit(execution.preflight.prepare(input)))._tag).toBe('Failure');
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
});

const noticeRequest = Schema.decodeUnknownSync(RecordNoticeProvisionPayloadSchema)({
  actionRef: 'commerce:account-marketing',
  anonymousContextRef: null,
  businessInteractionRef: 'interaction:one',
  channel: 'EMAIL',
  claimRef: 'receipt:one',
  controllerRef: legalEntityId,
  noticeVersionRef: 'notice-version:one',
  privacySubjectRef: 'retail-party:one',
  processingPurposeRef: 'purpose:one',
  processingScopeRef: 'scope:one',
  providedLanguage: 'cs',
});
const noticeInput = { ...input, actionKey: 'privacy.core.record-notice-provision', payload: noticeRequest };
const noticeContext = { actionInvocationId: input.actionInvocationId, legalEntityId, principalId, tenantId };
const noticeFact = Schema.decodeUnknownSync(PrivacyNoticeAuthorityFactSchema)({
  claimRef: noticeRequest.claimRef,
  provision: {
    actionRef: noticeRequest.actionRef,
    anonymousContextRef: null,
    businessInteractionRef: noticeRequest.businessInteractionRef,
    channel: noticeRequest.channel,
    channelProof: {
      anonymousContextRef: null,
      authorityRef: 'commerce:notice-receipt',
      businessInteractionRef: noticeRequest.businessInteractionRef,
      channel: noticeRequest.channel,
      controllerRef: legalEntityId,
      evidenceRef: noticeRequest.claimRef,
      noticeVersionRef: noticeRequest.noticeVersionRef,
      observedAt: '2026-10-23T00:00:00Z',
      privacySubjectRef: noticeRequest.privacySubjectRef,
      processingPurposeRef: noticeRequest.processingPurposeRef,
      processingScopeRef: noticeRequest.processingScopeRef,
      proofKind: 'INTERACTIVE_ACKNOWLEDGEMENT',
      providedLanguage: 'cs',
    },
    controllerRef: legalEntityId,
    evidenceRef: noticeRequest.claimRef,
    failureReason: null,
    noticeVersionRef: noticeRequest.noticeVersionRef,
    outcome: 'PROVEN_PROVISION',
    privacySubjectRef: noticeRequest.privacySubjectRef,
    processingPurposeRef: noticeRequest.processingPurposeRef,
    processingScopeRef: noticeRequest.processingScopeRef,
    providedLanguage: 'cs',
    provisionedAt: '2026-10-23T00:00:00Z',
    provisionId: 'commerce-notice:receipt:one',
    supersedesProvisionRef: null,
  },
});
const noticeLookup: CommerceConsentAuthorityLookupService = {
  resolve: () =>
    Effect.fail(
      new ConsentSelfServiceAuthorizationError({ code: 'MISSING_AUTHORITY', reason: 'Consent not requested' }),
    ),
  resolveNotice: () => Effect.succeed(noticeFact),
};

describe('Commerce notice authority preparation', () => {
  it.effect('consumes an exact invocation-bound explicit acknowledgement once without owner I/O in the handler', () =>
    Effect.gen(function* noticeExactInvocation() {
      let reads = 0;
      const execution = yield* prepareExecution({
        ...noticeLookup,
        resolveNotice: () =>
          Effect.sync(() => {
            reads += 1;
            return noticeFact;
          }),
      });
      expect(yield* execution.preflight.prepare(noticeInput)).toEqual({ outcome: 'not_applicable' });
      expect(reads).toBe(1);
      expect(yield* execution.noticeAuthority.resolve(noticeRequest, noticeContext)).toEqual(noticeFact);
      expect(reads).toBe(1);
      expect((yield* Effect.exit(execution.noticeAuthority.resolve(noticeRequest, noticeContext)))._tag).toBe(
        'Failure',
      );
    }).pipe(Effect.scoped),
  );
  it.effect('rejects changed request, invocation, actor and owner scope, consuming the mismatched evidence', () =>
    Effect.gen(function* noticeRequestBinding() {
      for (const context of [
        { ...noticeContext, actionInvocationId: 'invocation:other' },
        { ...noticeContext, principalId: legalEntityId },
        { ...noticeContext, tenantId: legalEntityId },
        { ...noticeContext, legalEntityId: tenantId },
      ]) {
        const execution = yield* prepareExecution(noticeLookup);
        yield* execution.preflight.prepare(noticeInput);
        expect((yield* Effect.exit(execution.noticeAuthority.resolve(noticeRequest, context)))._tag).toBe('Failure');
        expect((yield* Effect.exit(execution.noticeAuthority.resolve(noticeRequest, noticeContext)))._tag).toBe(
          'Failure',
        );
      }
      const execution = yield* prepareExecution(noticeLookup);
      yield* execution.preflight.prepare(noticeInput);
      expect(
        (yield* Effect.exit(
          execution.noticeAuthority.resolve({ ...noticeRequest, noticeVersionRef: 'notice:other' }, noticeContext),
        ))._tag,
      ).toBe('Failure');
    }).pipe(Effect.scoped),
  );
  it.effect('rejects mismatched receipt claims and inconsistent native scopes before preparing evidence', () =>
    Effect.gen(function* noticeClaimBinding() {
      const execution = yield* prepareExecution({
        ...noticeLookup,
        resolveNotice: () => Effect.succeed({ ...noticeFact, claimRef: 'receipt:other' }),
      });
      expect(yield* execution.preflight.prepare(noticeInput)).toEqual({ outcome: 'denied' });
      expect((yield* Effect.exit(execution.noticeAuthority.resolve(noticeRequest, noticeContext)))._tag).toBe(
        'Failure',
      );
      expect(
        yield* execution.preflight.prepare({ ...noticeInput, scope: { ...input.scope, tenantId: legalEntityId } }),
      ).toEqual({ outcome: 'denied' });
    }).pipe(Effect.scoped),
  );
  it.effect('keeps independent invocation evidence isolated and erases it when the owner scope closes', () =>
    Effect.gen(function* noticeScopeFinalization() {
      const first = yield* Effect.scoped(
        Effect.gen(function* firstNoticeScope() {
          const execution = yield* prepareExecution(noticeLookup);
          yield* execution.preflight.prepare(noticeInput);
          return execution;
        }),
      );
      expect((yield* Effect.exit(first.noticeAuthority.resolve(noticeRequest, noticeContext)))._tag).toBe('Failure');
      const second = yield* prepareExecution(noticeLookup);
      const third = yield* prepareExecution(noticeLookup);
      yield* second.preflight.prepare(noticeInput);
      expect((yield* Effect.exit(third.noticeAuthority.resolve(noticeRequest, noticeContext)))._tag).toBe('Failure');
      expect(yield* second.noticeAuthority.resolve(noticeRequest, noticeContext)).toEqual(noticeFact);
    }).pipe(Effect.scoped),
  );
  it.effect('fails closed on an owner outage without retaining previously prepared evidence', () =>
    Effect.gen(function* noticeUnavailable() {
      let available = true;
      const execution = yield* prepareExecution({
        ...noticeLookup,
        resolveNotice: () =>
          available
            ? Effect.succeed(noticeFact)
            : unavailableNotice({ preflight: noticeInput, request: noticeRequest }),
      });
      yield* execution.preflight.prepare(noticeInput);
      available = false;
      expect((yield* Effect.exit(execution.preflight.prepare(noticeInput)))._tag).toBe('Failure');
      expect((yield* Effect.exit(execution.noticeAuthority.resolve(noticeRequest, noticeContext)))._tag).toBe(
        'Failure',
      );
    }).pipe(Effect.scoped),
  );
});

describe('Prepared Commerce evidence lifecycle', () => {
  it.effect('clears notice evidence on native failure and interruption, not only successful scope exit', () =>
    Effect.gen(function* noticeFailureFinalization() {
      for (const ending of [Effect.fail('stopped-before-commit'), Effect.interrupt]) {
        const captured = yield* Ref.make(Option.none<PreparedCommerceConsentExecution>());
        expect(
          (yield* Effect.exit(
            Effect.scoped(
              Effect.gen(function* interruptedNoticeScope() {
                const execution = yield* prepareExecution(noticeLookup);
                yield* execution.preflight.prepare(noticeInput);
                yield* Ref.set(captured, Option.some(execution));
                return yield* ending;
              }),
            ),
          ))._tag,
        ).toBe('Failure');
        const execution = yield* Ref.get(captured);
        if (Option.isNone(execution)) {
          return yield* Effect.fail('Evidence preparation did not run');
        }
        expect((yield* Effect.exit(execution.value.noticeAuthority.resolve(noticeRequest, noticeContext)))._tag).toBe(
          'Failure',
        );
      }
      return yield* Effect.void;
    }),
  );
});
