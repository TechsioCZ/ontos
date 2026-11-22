import { PreVerificationEligibilityRequestSchema } from '@app/privacy/api/pre-verification-eligibility';
import type { PreVerificationEligibilityRequest } from '@app/privacy/api/pre-verification-eligibility';
import { executePreVerificationEligibilityWithAuthorization } from '@app/privacy/api/pre-verification-eligibility/client';
import { SourceProcessingEligibilityRequestSchema } from '@app/privacy/api/source-processing-eligibility';
import type { SourceProcessingEligibilityRequest } from '@app/privacy/api/source-processing-eligibility';
import { executeSourceProcessingEligibilityWithAuthorization } from '@app/privacy/api/source-processing-eligibility/client';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import { Crypto, Effect, Layer, Option, Schema } from 'effect';
import type { Duration } from 'effect';

import { ProcessingEligibilityUnavailable } from '../domain/privacy/eligibility-errors.ts';
import { ProcessingEligibilityGate } from '../domain/privacy/eligibility-gate.ts';
import type { ProcessingEligibilityQuery } from '../domain/privacy/eligibility-gate.ts';
import {
  eligibilityVerdictOf,
  PrivacySourceEligibilityResponseSchema,
  unavailableReasonOfOwnerProblem,
} from '../domain/privacy/source-eligibility-response.ts';
import { safeCauseOf } from '../domain/intake/safe-cause.ts';
import { PRIVACY_ELIGIBILITY_REQUIREMENT_KEY } from '../handoff/requirement-keys.ts';
import { CurrentOwnerCall } from './owner-call.ts';
import type { OwnerCall } from './owner-call.ts';

const SOURCE_DECLARATION_KEY = 'privacy.core.source-processing-eligibility.read';
const PRE_VERIFICATION_DECLARATION_KEY = 'privacy.core.pre-verification-eligibility.read';
const HTTP_STATUS_SERVICE_UNAVAILABLE = 503;

/**
 * A typed failure that keeps only the SAFE kind of the failure it replaces as a non-enumerable cause: a failed owner call
 * can carry the exact Privacy request (recipient and subject references), which no log may print.
 */
const unavailableBecause = (reason: ProcessingEligibilityUnavailable['reason'], cause: unknown) =>
  Object.defineProperty(new ProcessingEligibilityUnavailable({ reason }), 'cause', {
    enumerable: false,
    value: safeCauseOf(cause),
  });

/** A request the published contract refuses names no exact Privacy context: it is never sent. */
const ambiguous = (cause: Schema.SchemaError) => unavailableBecause('CONTEXT_AMBIGUOUS', cause);
const decodeSourceRequest = Schema.decodeUnknownEffect(SourceProcessingEligibilityRequestSchema, {
  onExcessProperty: 'error',
});
const decodePreVerificationRequest = Schema.decodeUnknownEffect(PreVerificationEligibilityRequestSchema, {
  onExcessProperty: 'error',
});

/** The exact source-processing request of ONE declared scope: a located source record or the Party target, nothing else. */
export const privacyRequestOf = (query: ProcessingEligibilityQuery) => {
  const { subject } = query.scope;
  return decodeSourceRequest({
    consumerModuleId: 'communications.core',
    operation: query.scope.operation,
    source: subject.kind === 'SOURCE_ASSERTED' ? subject.source : null,
    target: subject.kind === 'PARTY_TARGET' ? { kind: 'PARTY', resourceId: subject.partyRef.resourceId } : null,
  }).pipe(Effect.mapError(ambiguous));
};

/**
 * ONE question to the Privacy owner and the published Read that answers it. A subject Privacy bound before the address
 * was verified is asked through its pre-verification Read, by Privacy's own binding, the catalog purpose (the source
 * purpose Privacy's policy names) and the activity; every other locator through the source-processing Read. Both Reads
 * answer in the same published shape, so the answer is read the same way.
 */
export type PrivacyOwnerQuestion =
  | {
      readonly declarationKey: typeof PRE_VERIFICATION_DECLARATION_KEY;
      readonly kind: 'PRE_VERIFICATION';
      readonly request: PreVerificationEligibilityRequest;
    }
  | {
      readonly declarationKey: typeof SOURCE_DECLARATION_KEY;
      readonly kind: 'SOURCE_PROCESSING';
      readonly request: SourceProcessingEligibilityRequest;
    };

export const privacyQuestionOf = (
  query: ProcessingEligibilityQuery,
): Effect.Effect<PrivacyOwnerQuestion, ProcessingEligibilityUnavailable> => {
  const { scope } = query;
  if (scope.subject.kind === 'PRIVACY_BINDING') {
    return decodePreVerificationRequest({
      bindingRef: scope.subject.bindingRef,
      consumerModuleId: 'communications.core',
      operation: scope.operation,
      sourcePurposeRef: scope.catalogPurposeRef,
    }).pipe(
      Effect.mapError(ambiguous),
      Effect.map((request) => ({
        declarationKey: PRE_VERIFICATION_DECLARATION_KEY,
        kind: 'PRE_VERIFICATION' as const,
        request,
      })),
    );
  }
  return privacyRequestOf(query).pipe(
    Effect.map((request) => ({ declarationKey: SOURCE_DECLARATION_KEY, kind: 'SOURCE_PROCESSING' as const, request })),
  );
};

/** A failed owner call: a published problem with its status, or any other failure to answer. */
type OwnerCallFailure = Error | { readonly status: number };

/**
 * How ONE question reaches the Privacy owner under the authority of the operation in progress. The production transport
 * is Privacy's public Read through its generated client with a fresh delegated assertion; it is the only part a
 * composition replaces, so the request, the decoding of the answer and the verdict are always the code below.
 */
export type PrivacyOwnerTransport = (
  question: PrivacyOwnerQuestion,
  call: OwnerCall,
) => Effect.Effect<unknown, OwnerCallFailure>;

const ProblemStatusSchema = Schema.Struct({ status: Schema.Number });
/** The reason a failed Privacy call stands for: its published problem status, else the owner being unavailable. */
const reasonOfFailure = (failure: OwnerCallFailure) =>
  unavailableReasonOfOwnerProblem(
    Schema.decodeUnknownOption(ProblemStatusSchema)(failure).pipe(
      Option.match({ onNone: () => HTTP_STATUS_SERVICE_UNAVAILABLE, onSome: ({ status }) => status }),
    ),
  );

/**
 * The check over one transport. A failure to reach a decision (no authority to ask under, denied access, owner outage,
 * an invalid response) is `ProcessingEligibilityUnavailable`, never a Privacy outcome: only Privacy's own response with
 * its evidence can be `ALLOWED`, `NOT_ALLOWED` or `INDETERMINATE`.
 */
const checkOver = (transport: PrivacyOwnerTransport) =>
  Effect.fn('CommunicationsPrivacyEligibility.check')(function* checkEligibility(query: ProcessingEligibilityQuery) {
    const call = yield* CurrentOwnerCall;
    if (Option.isNone(call)) {
      return yield* new ProcessingEligibilityUnavailable({ reason: 'AUTHORIZATION_DENIED' });
    }
    const question = yield* privacyQuestionOf(query);
    const owner = yield* transport(question, call.value).pipe(
      Effect.mapError((failure) => unavailableBecause(reasonOfFailure(failure), failure)),
    );
    const response = yield* Schema.decodeUnknownEffect(PrivacySourceEligibilityResponseSchema)(owner).pipe(
      Effect.mapError((cause) => unavailableBecause('OWNER_UNAVAILABLE', cause)),
    );
    return eligibilityVerdictOf(response, query.scope);
  });

/** The delegated assertion Shell issued for one call, as the gateway returns it. */
type IssuedDelegation = Effect.Success<ReturnType<typeof acquireDelegatedGatewayContext>>;

/** The published Read of the question, called with the issued delegated assertion. */
const askOwnerWith = Effect.fn('CommunicationsPrivacyEligibility.askOwner')(function* askOwner(
  question: PrivacyOwnerQuestion,
  issued: IssuedDelegation,
  correlation: string,
) {
  const options = { baseUrl: new URL(issued.apiBaseUrl), compositionRevision: issued.compositionRevision };
  if (question.kind === 'PRE_VERIFICATION') {
    return yield* executePreVerificationEligibilityWithAuthorization(
      question.request,
      issued.authorization,
      correlation,
      options,
    );
  }
  return yield* executeSourceProcessingEligibilityWithAuthorization(
    question.request,
    issued.authorization,
    correlation,
    options,
  );
});

/** The gate over a given transport: the production one below, or a composition's own (a native test seam, for example). */
export const privacyProcessingEligibilityGateOver = (
  settings: { readonly checkTimeout: Duration.Input },
  transport: PrivacyOwnerTransport,
) => Layer.succeed(ProcessingEligibilityGate, { ...settings, check: checkOver(transport) });

/**
 * Privacy's PUBLIC Reads through their generated clients, with a fresh delegated assertion on EVERY check under the
 * authority of the operation in progress (`CurrentOwnerCall`), naming the exact declaration of the Read it asks.
 */
export const privacyProcessingEligibilityGateLive = (settings: { readonly checkTimeout: Duration.Input }) =>
  Layer.unwrap(
    Effect.gen(function* privacyEligibilityGate() {
      const crypto = yield* Crypto.Crypto;
      const transport: PrivacyOwnerTransport = (question, call) =>
        acquireDelegatedGatewayContext(
          {
            audience: 'privacy',
            legalEntityScope: 'subject',
            requestCorrelation: call.correlation(),
            subject: call.subjectFor({
              declarationKey: question.declarationKey,
              decodedRequest: question.request,
              operationRequirementKey: PRIVACY_ELIGIBILITY_REQUIREMENT_KEY,
            }),
          },
          crypto,
        ).pipe(Effect.flatMap((issued) => askOwnerWith(question, issued, call.correlation())));
      return privacyProcessingEligibilityGateOver(settings, transport);
    }),
  );
