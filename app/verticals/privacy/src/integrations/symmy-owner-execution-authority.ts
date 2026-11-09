import { requireModuleOperation } from '@app/core-runtime';
import { readVerifiedGatewayPrivacyDispatch } from '@app/core-runtime/auth/system-principal-context-provenance';
import { executeSymmyJobPrivacyExecutionWithAuthorization } from '@app/symmy-integration/api/symmy-job-privacy-execution/client';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import type { GatewayDelegationSubject } from '@app/shared-contracts/gateway-context-server';
import { Crypto, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { Hex } from 'effect/encoding';

import {
  OwnerExecutionAuthorityResultSchema,
  PrivacyMeasureHandoffSchema,
  validateOwnerExecutionAuthorityResult,
} from '../../shared/domain/privacy-measure-handoff.ts';
import type {
  OwnerExecutionOutcomeRequest,
  PrivacyMeasureHandoff,
} from '../../shared/domain/privacy-measure-handoff.ts';
import {
  OwnerExecutionAuthority,
  ownerExecutionAuthorityUnavailable,
} from '../actions/privacy-owner-execution-authority.ts';
import type { OwnerExecutionAuthorityContext } from '../actions/privacy-owner-execution-authority.ts';
import { PrivacyOperationPersistenceError } from '../persistence/privacy-operation-persistence-error.ts';

const unavailable = (cause?: unknown) =>
  Object.defineProperty(
    new PrivacyOperationPersistenceError({
      code: 'privacy_operation_persistence_unavailable',
      reason: 'Authoritative Symmy execution receipt is unavailable',
    }),
    'cause',
    { configurable: true, value: Redacted.make(cause) },
  );
const conflict = (reason: string) =>
  new PrivacyOperationPersistenceError({ code: 'privacy_operation_conflict', reason });
const symmyReceiptRequirement = 'privacy.core.requirement.symmy-owner-execution-outcome';

export const fingerprintSymmyOwnerHandoff = Effect.fn('Privacy.SymmyOwnerReceipt.fingerprint')(function* fingerprint(
  handoff: PrivacyMeasureHandoff,
  crypto: Crypto.Crypto,
) {
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(PrivacyMeasureHandoffSchema))({
    ...handoff,
    contentScopeRefs: handoff.contentScopeRefs.toSorted(),
    expectedEvidenceRefs: handoff.expectedEvidenceRefs.toSorted(),
    preconditionRefs: handoff.preconditionRefs.toSorted(),
    resourceRefs: handoff.resourceRefs.toSorted(),
  }).pipe(Effect.mapError(unavailable));
  return Hex.encode(
    yield* crypto.digest('SHA-256', new TextEncoder().encode(encoded)).pipe(Effect.mapError(unavailable)),
  );
});
interface ReceiptTransport {
  readonly authorization: Redacted.Redacted;
  readonly baseUrl: string;
  readonly compositionRevision: string;
}

/** Independent public owner receipt read; the callback payload can never supply its result. */
export const resolveSymmyOwnerExecutionReceipt = Effect.fn('Privacy.SymmyOwnerReceipt.resolve')(function* resolve(
  request: OwnerExecutionOutcomeRequest,
  context: OwnerExecutionAuthorityContext,
  transport: ReceiptTransport,
  crypto: Crypto.Crypto,
) {
  const { handoff, scope } = context;
  if (
    handoff.owningCapability !== 'integration.symmy' ||
    context.tenantId !== scope.tenantId ||
    context.legalEntityId !== scope.legalEntityId ||
    context.principalId !== scope.principalId ||
    handoff.tenantId !== scope.tenantId ||
    request.measureId !== handoff.measureId ||
    request.taskId !== handoff.taskId
  ) {
    return yield* conflict('Symmy receipt request does not match the trusted Privacy dispatch');
  }
  const result = yield* executeSymmyJobPrivacyExecutionWithAuthorization(
    { attempt: request.attempt, idempotencyKey: handoff.idempotencyKey },
    Redacted.value(transport.authorization),
    scope.correlationId,
    { baseUrl: transport.baseUrl, compositionRevision: transport.compositionRevision },
  ).pipe(Effect.mapError(unavailable));
  if (Option.isNone(result)) {
    return yield* unavailable();
  }
  const receipt = result.value;
  if (receipt.handoffFingerprint !== (yield* fingerprintSymmyOwnerHandoff(handoff, crypto))) {
    return yield* conflict('Symmy receipt does not attest the exact complete Privacy handoff');
  }
  const authority = yield* Schema.decodeUnknownEffect(OwnerExecutionAuthorityResultSchema)({
    authorityRef: 'integration.symmy.api.symmy-job-privacy-execution',
    contentScopeRefs: handoff.contentScopeRefs,
    evidenceRefs: receipt.outcome.evidenceRefs,
    outcome: receipt.outcome,
    receiptRef: receipt.outcome.outcomeId,
    resourceRefs: handoff.resourceRefs,
    subjectRef: handoff.subjectRef,
    tenantId: handoff.tenantId,
  }).pipe(Effect.mapError(unavailable));
  const invalid = validateOwnerExecutionAuthorityResult(handoff, request, authority);
  if (invalid !== undefined) {
    return yield* conflict(invalid);
  }
  return authority;
});

/** Existing unsupported owners stay unavailable. The finite dispatch carrier preserves the
 * original human and governance scope for current processing and durable receipt recovery. */
export const SymmyOwnerExecutionAuthorityLive = Layer.effect(
  OwnerExecutionAuthority,
  Effect.gen(function* make() {
    const crypto = yield* Crypto.Crypto;
    return OwnerExecutionAuthority.of({
      resolve: Effect.fn('Privacy.SymmyOwnerExecutionAuthority.resolve')(function* resolve(request, context) {
        if (context.handoff.owningCapability !== 'integration.symmy') {
          return yield* ownerExecutionAuthorityUnavailable.resolve();
        }
        const originator = context.dispatchOriginator;
        if (originator === undefined) {
          return yield* unavailable();
        }
        yield* requireModuleOperation(symmyReceiptRequirement).pipe(Effect.mapError(unavailable));
        const dispatch = readVerifiedGatewayPrivacyDispatch(context.scope);
        let subject: GatewayDelegationSubject;
        if (dispatch === undefined) {
          subject = {
            _tag: 'PrivacyDispatch',
            operation: { _tag: 'SymmyReceipt', attempt: request.attempt },
            operationRequirementKey: symmyReceiptRequirement,
            source: {
              _tag: 'Dispatch',
              compositionRevision: originator.compositionRevision,
              dispatchInvocationId: originator.actionInvocationId,
              legalEntityId: context.legalEntityId,
              tenantId: context.tenantId,
            },
          };
        } else {
          if (
            dispatch.dispatchInvocationId !== originator.actionInvocationId ||
            dispatch.measureId !== context.handoff.measureId ||
            dispatch.taskId !== context.handoff.taskId ||
            dispatch.tenantId !== context.tenantId ||
            dispatch.governanceLegalEntityId !== context.legalEntityId ||
            dispatch.principalId !== context.principalId ||
            dispatch.operation !== 'PrivacyOutcome'
          ) {
            return yield* conflict('The current Privacy dispatch carrier does not match the stored handoff');
          }
          subject = {
            _tag: 'PrivacyDispatch',
            operation: { _tag: 'SymmyReceipt', attempt: request.attempt },
            operationRequirementKey: symmyReceiptRequirement,
            source: { _tag: 'Assertion', scope: context.scope },
          };
        }
        const issued = yield* acquireDelegatedGatewayContext(
          {
            audience: 'symmy-integration',
            legalEntityScope: 'subject',
            requestCorrelation: context.scope.correlationId,
            subject,
          },
          crypto,
        ).pipe(Effect.mapError(unavailable));
        return yield* resolveSymmyOwnerExecutionReceipt(
          request,
          context,
          {
            authorization: Redacted.make(issued.authorization),
            baseUrl: issued.apiBaseUrl,
            compositionRevision: issued.compositionRevision,
          },
          crypto,
        );
      }),
    });
  }),
);
