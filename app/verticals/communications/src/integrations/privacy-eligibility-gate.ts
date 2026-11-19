import { SourceProcessingEligibilityRequestSchema } from '@app/privacy/api/source-processing-eligibility';
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

const DECLARATION_KEY = 'privacy.core.source-processing-eligibility.read';
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

/** The exact Privacy request of ONE declared scope: a located source record or the Party target, and nothing else. */
export const privacyRequestOf = (query: ProcessingEligibilityQuery) => {
  const { subject } = query.scope;
  return Schema.decodeUnknownEffect(SourceProcessingEligibilityRequestSchema, { onExcessProperty: 'error' })({
    consumerModuleId: 'communications.core',
    operation: query.scope.operation,
    source: subject.kind === 'SOURCE_ASSERTED' ? subject.source : null,
    target: subject.kind === 'PARTY_TARGET' ? { kind: 'PARTY', resourceId: subject.partyRef.resourceId } : null,
  }).pipe(Effect.mapError((cause) => unavailableBecause('CONTEXT_AMBIGUOUS', cause)));
};

const ProblemStatusSchema = Schema.Struct({ status: Schema.Number });
/** The reason a failed Privacy call stands for: its published problem status, else the owner being unavailable. */
const reasonOfFailure = (failure: Error | ProcessingEligibilityUnavailable | { readonly status: number }) =>
  unavailableReasonOfOwnerProblem(
    Schema.decodeUnknownOption(ProblemStatusSchema)(failure).pipe(
      Option.match({ onNone: () => HTTP_STATUS_SERVICE_UNAVAILABLE, onSome: ({ status }) => status }),
    ),
  );

/**
 * Privacy's PUBLIC Read through its generated client, with a fresh delegated assertion on EVERY check under the
 * authority of the operation in progress (`CurrentOwnerCall`). A failure to reach a decision (denied access, owner
 * outage, no authority to ask under, an invalid response) is `ProcessingEligibilityUnavailable`, never a Privacy
 * outcome: only Privacy's own response with its evidence can be `ALLOWED`, `NOT_ALLOWED` or `INDETERMINATE`.
 */
export const privacyProcessingEligibilityGateLive = (settings: { readonly checkTimeout: Duration.Input }) =>
  Layer.effect(
    ProcessingEligibilityGate,
    Effect.gen(function* privacyEligibilityGate() {
      const crypto = yield* Crypto.Crypto;
      const check = Effect.fn('CommunicationsPrivacyEligibility.check')(function* checkEligibility(
        query: ProcessingEligibilityQuery,
      ) {
        const call = yield* CurrentOwnerCall;
        if (Option.isNone(call)) {
          return yield* new ProcessingEligibilityUnavailable({ reason: 'AUTHORIZATION_DENIED' });
        }
        const request = yield* privacyRequestOf(query);
        const owner = yield* acquireDelegatedGatewayContext(
          {
            audience: 'privacy',
            legalEntityScope: 'subject',
            requestCorrelation: call.value.correlation(),
            subject: call.value.subjectFor({
              declarationKey: DECLARATION_KEY,
              decodedRequest: request,
              operationRequirementKey: PRIVACY_ELIGIBILITY_REQUIREMENT_KEY,
            }),
          },
          crypto,
        ).pipe(
          Effect.flatMap((issued) =>
            executeSourceProcessingEligibilityWithAuthorization(
              request,
              issued.authorization,
              call.value.correlation(),
              {
                baseUrl: new URL(issued.apiBaseUrl),
                compositionRevision: issued.compositionRevision,
              },
            ),
          ),
          Effect.mapError((failure) => unavailableBecause(reasonOfFailure(failure), failure)),
        );
        const response = yield* Schema.decodeUnknownEffect(PrivacySourceEligibilityResponseSchema)(owner).pipe(
          Effect.mapError((cause) => unavailableBecause('OWNER_UNAVAILABLE', cause)),
        );
        return eligibilityVerdictOf(response, query.scope);
      });
      return { ...settings, check };
    }),
  );
