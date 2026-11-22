import { requireModuleOperation } from '@app/core-runtime';
import { readVerifiedGatewayPrivacyDispatch } from '@app/core-runtime/auth/system-principal-context-provenance';
import { executePrivacyOwnerExecutionOutcomeWithAuthorization } from '@app/communications/api/privacy-owner-execution-outcome/client';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import type { GatewayDelegationSubject } from '@app/shared-contracts/gateway-context-server';
import { Crypto, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { Hex } from 'effect/encoding';

import {
  normalizePrivacyMeasureHandoff,
  OwnerExecutionAuthorityResultSchema,
  PrivacyMeasureHandoffSchema,
  validateOwnerExecutionAuthorityResult,
} from '../../shared/domain/privacy-measure-handoff.ts';
import type {
  OwnerExecutionOutcomeRequest,
  PrivacyMeasureHandoff,
} from '../../shared/domain/privacy-measure-handoff.ts';
import { OwnerExecutionAuthority } from '../actions/privacy-owner-execution-authority.ts';
import type { OwnerExecutionAuthorityContext } from '../actions/privacy-owner-execution-authority.ts';
import { PrivacyOperationPersistenceError } from '../persistence/privacy-operation-persistence-error.ts';

const COMMUNICATIONS_CAPABILITY = 'communications.core';
const communicationsReceiptRequirement = 'privacy.core.requirement.communications-owner-execution-outcome';

const unavailable = (cause?: unknown) =>
  Object.defineProperty(
    new PrivacyOperationPersistenceError({
      code: 'privacy_operation_persistence_unavailable',
      reason: 'Authoritative Communications execution receipt is unavailable',
    }),
    'cause',
    { configurable: true, value: Redacted.make(cause) },
  );
const conflict = (reason: string) =>
  new PrivacyOperationPersistenceError({ code: 'privacy_operation_conflict', reason });

const encodeHandoff = Schema.encodeEffect(Schema.fromJsonString(PrivacyMeasureHandoffSchema));

/**
 * The exact complete handoff fingerprint: the same codec and set normalization the owner applies to the same handoff, so the
 * owner's receipt attests the handoff Privacy dispatched and not a caller's copy of it.
 */
export const fingerprintCommunicationsOwnerHandoff = Effect.fn('Privacy.CommunicationsOwnerReceipt.fingerprint')(
  function* fingerprint(handoff: PrivacyMeasureHandoff, crypto: Crypto.Crypto) {
    const encoded = yield* encodeHandoff(normalizePrivacyMeasureHandoff(handoff)).pipe(Effect.mapError(unavailable));
    return Hex.encode(
      yield* crypto.digest('SHA-256', new TextEncoder().encode(encoded)).pipe(Effect.mapError(unavailable)),
    );
  },
);

interface ReceiptTransport {
  readonly authorization: Redacted.Redacted;
  readonly baseUrl: string;
  readonly compositionRevision: string;
}

/** Independent public owner receipt read; the callback payload can never supply its result. */
export const resolveCommunicationsOwnerExecutionReceipt = Effect.fn('Privacy.CommunicationsOwnerReceipt.resolve')(
  function* resolve(
    request: OwnerExecutionOutcomeRequest,
    context: OwnerExecutionAuthorityContext,
    transport: ReceiptTransport,
    crypto: Crypto.Crypto,
  ) {
    const { handoff, scope } = context;
    if (
      handoff.owningCapability !== COMMUNICATIONS_CAPABILITY ||
      context.tenantId !== scope.tenantId ||
      context.legalEntityId !== scope.legalEntityId ||
      context.principalId !== scope.principalId ||
      handoff.tenantId !== scope.tenantId ||
      request.measureId !== handoff.measureId ||
      request.taskId !== handoff.taskId
    ) {
      return yield* conflict('Communications receipt request does not match the trusted Privacy dispatch');
    }
    const result = yield* executePrivacyOwnerExecutionOutcomeWithAuthorization(
      { attempt: request.attempt, handoff },
      Redacted.value(transport.authorization),
      scope.correlationId,
      { baseUrl: transport.baseUrl, compositionRevision: transport.compositionRevision },
    ).pipe(Effect.mapError(unavailable));
    if (Option.isNone(result)) {
      return yield* unavailable();
    }
    const receipt = result.value;
    if (receipt.handoffFingerprint !== (yield* fingerprintCommunicationsOwnerHandoff(handoff, crypto))) {
      return yield* conflict('Communications receipt does not attest the exact complete Privacy handoff');
    }
    const authority = yield* Schema.decodeUnknownEffect(OwnerExecutionAuthorityResultSchema)({
      authorityRef: 'communications.core.api.privacy-owner-execution-outcome',
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
  },
);

/**
 * How Privacy asks for the receipt of one stored Communications dispatch. Without a carrier (a later pull) and under a
 * continuation carrier (a later human-recorded confirmation the owner pushed) it is Privacy's own durable receipt read of
 * the original dispatch: a continuation reports one outcome and is never continued, so the report never supplies the
 * result. Under the take-over worker's carrier it continues that exact carrier. A carrier of another dispatch is none.
 */
export const communicationsReceiptSubject = (
  request: OwnerExecutionOutcomeRequest,
  context: Pick<OwnerExecutionAuthorityContext, 'handoff' | 'legalEntityId' | 'principalId' | 'scope' | 'tenantId'>,
  originator: NonNullable<OwnerExecutionAuthorityContext['dispatchOriginator']>,
  dispatch: ReturnType<typeof readVerifiedGatewayPrivacyDispatch>,
): Option.Option<GatewayDelegationSubject> => {
  if (
    dispatch !== undefined &&
    (dispatch.dispatchInvocationId !== originator.actionInvocationId ||
      dispatch.measureId !== context.handoff.measureId ||
      dispatch.taskId !== context.handoff.taskId ||
      dispatch.tenantId !== context.tenantId ||
      dispatch.governanceLegalEntityId !== context.legalEntityId ||
      dispatch.principalId !== context.principalId ||
      dispatch.operation !== 'PrivacyOutcome')
  ) {
    return Option.none();
  }
  const source =
    dispatch === undefined || dispatch.sourceMode === 'continuation'
      ? {
          _tag: 'Dispatch' as const,
          compositionRevision: originator.compositionRevision,
          dispatchInvocationId: originator.actionInvocationId,
          legalEntityId: context.legalEntityId,
          tenantId: context.tenantId,
        }
      : { _tag: 'Assertion' as const, scope: context.scope };
  return Option.some({
    _tag: 'PrivacyDispatch',
    operation: { _tag: 'CommunicationsReceipt', attempt: request.attempt },
    operationRequirementKey: communicationsReceiptRequirement,
    source,
  });
};

/**
 * Communications' owner receipt through the finite dispatch capability, in front of the authority it is composed with: every
 * other owner is answered by that authority exactly as before. The finite carrier preserves the original human and
 * governance scope for current processing and durable receipt recovery.
 */
export const CommunicationsOwnerExecutionAuthorityLive = Layer.effect(
  OwnerExecutionAuthority,
  Effect.gen(function* make() {
    const crypto = yield* Crypto.Crypto;
    const otherOwners = yield* OwnerExecutionAuthority;
    return OwnerExecutionAuthority.of({
      resolve: Effect.fn('Privacy.CommunicationsOwnerExecutionAuthority.resolve')(function* resolve(request, context) {
        if (context.handoff.owningCapability !== COMMUNICATIONS_CAPABILITY) {
          return yield* otherOwners.resolve(request, context);
        }
        const originator = context.dispatchOriginator;
        if (originator === undefined) {
          return yield* unavailable();
        }
        yield* requireModuleOperation(communicationsReceiptRequirement).pipe(Effect.mapError(unavailable));
        const subject = communicationsReceiptSubject(
          request,
          context,
          originator,
          readVerifiedGatewayPrivacyDispatch(context.scope),
        );
        if (Option.isNone(subject)) {
          return yield* conflict('The current Privacy dispatch carrier does not match the stored handoff');
        }
        const issued = yield* acquireDelegatedGatewayContext(
          {
            audience: 'communications',
            legalEntityScope: 'subject',
            requestCorrelation: context.scope.correlationId,
            subject: subject.value,
          },
          crypto,
        ).pipe(Effect.mapError(unavailable));
        return yield* resolveCommunicationsOwnerExecutionReceipt(
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
