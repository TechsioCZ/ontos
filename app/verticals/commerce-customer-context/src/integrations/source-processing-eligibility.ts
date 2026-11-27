import type { OperationalScope } from '@app/core-runtime';
import {
  SourceProcessingEligibilityResponseSchema,
  SourceProcessingEligibilityRequestSchema,
  SourceProcessingEligibilitySetResponseSchema,
} from '@app/privacy-contracts/source-processing-eligibility';
import type { SourceProcessingEligibilityRequest } from '@app/privacy-contracts/source-processing-eligibility';
import {
  executeSourceProcessingEligibilitySetWithAuthorization,
  executeSourceProcessingEligibilityWithAuthorization,
} from '@app/privacy-contracts/source-processing-eligibility/client';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import { Context, Crypto, DateTime, Effect, Layer, Schema } from 'effect';
import { sourceSyncProcessingSelected, requireSourceSyncProcessingPermit } from './source-sync-processing.ts';
import type { CommerceSourceProcessingAuthority } from './source-sync-processing.ts';
import { commerceSourceDelegationSubject } from './source-delegation-subject.ts';
import { CommerceSourceProcessingRejected } from './source-processing-rejected.ts';
import { commerceCustomerContextEvidenceCall } from '../declared-evidence-calls.ts';

export { CommerceSourceProcessingRejected } from './source-processing-rejected.ts';

export type CommerceSourceProcessingRequest = Omit<SourceProcessingEligibilityRequest, 'consumerModuleId'>;

export interface CommerceSourceProcessingEligibilityService {
  readonly check: (
    scope: OperationalScope,
    input: CommerceSourceProcessingRequest,
    operationRequirementKey: string,
  ) => Effect.Effect<CommerceSourceProcessingAuthority, CommerceSourceProcessingRejected>;
  /**
   * The decisions of several requests in one Privacy call, in their order, each judged exactly as `check` judges it:
   * any request that is not allowed refuses them all, as its own check would refuse.
   */
  readonly checkSet: (
    scope: OperationalScope,
    inputs: readonly CommerceSourceProcessingRequest[],
    operationRequirementKey: string,
  ) => Effect.Effect<readonly CommerceSourceProcessingAuthority[], CommerceSourceProcessingRejected>;
}

const rejected = (code: 'DENIED' | 'UNAVAILABLE', reason: string) => (cause?: unknown) =>
  Object.defineProperty(new CommerceSourceProcessingRejected({ code, reason }), 'cause', {
    configurable: true,
    value: cause,
  });

export class CommerceSourceProcessingEligibility extends Context.Service<
  CommerceSourceProcessingEligibility,
  CommerceSourceProcessingEligibilityService
>()('@app/commerce-customer-context/integrations/source-processing-eligibility/CommerceSourceProcessingEligibility') {}

/** Each attempt asks Privacy with fresh delegated authority; a retained positive result is never reused. */
export const commerceSourceProcessingEligibilityLive = Layer.effect(
  CommerceSourceProcessingEligibility,
  Effect.gen(function* commerceSourceProcessingEligibility() {
    const crypto = yield* Crypto.Crypto;
    return {
      check: Effect.fn('CommerceSourceProcessingEligibility.check')(
        function* check(scope, input, operationRequirementKey) {
          const request = yield* Schema.decodeUnknownEffect(SourceProcessingEligibilityRequestSchema, {
            onExcessProperty: 'error',
          })({
            ...input,
            consumerModuleId: 'commerce.customer-context',
          }).pipe(
            Effect.mapError((cause) =>
              Object.defineProperty(
                new CommerceSourceProcessingRejected({
                  code: 'UNAVAILABLE',
                  reason: 'The exact current source processing request is invalid',
                }),
                'cause',
                { value: cause },
              ),
            ),
          );
          // Declared in-transaction evidence call (demo divergence, DEPLOYMENT.md); see ../declared-evidence-calls.ts.
          const response = yield* acquireDelegatedGatewayContext(
            {
              audience: 'privacy',
              callingAppId: 'commerce-customer-context',
              legalEntityScope: 'subject',
              requestCorrelation: scope.correlationId,
              subject: commerceSourceDelegationSubject(
                scope,
                'privacy.core.source-processing-eligibility.read',
                request,
                operationRequirementKey,
              ),
            },
            crypto,
          ).pipe(
            Effect.flatMap((issued) =>
              executeSourceProcessingEligibilityWithAuthorization(request, issued.authorization, scope.correlationId, {
                baseUrl: new URL(issued.apiBaseUrl),
                compositionRevision: issued.compositionRevision,
              }),
            ),
            commerceCustomerContextEvidenceCall.sourceProcessingEligibility,
            Effect.mapError((cause) =>
              Object.defineProperty(
                new CommerceSourceProcessingRejected({
                  code: 'UNAVAILABLE',
                  reason: 'Current source Privacy authority is unavailable',
                }),
                'cause',
                { configurable: true, value: cause },
              ),
            ),
          );
          const decision = yield* Schema.decodeUnknownEffect(SourceProcessingEligibilityResponseSchema)(response).pipe(
            Effect.mapError((cause) =>
              Object.defineProperty(
                new CommerceSourceProcessingRejected({
                  code: 'UNAVAILABLE',
                  reason: 'Privacy returned invalid source processing evidence',
                }),
                'cause',
                { configurable: true, value: cause },
              ),
            ),
          );
          if (decision.outcome !== 'ALLOWED') {
            return yield* new CommerceSourceProcessingRejected({
              code: 'DENIED',
              reason: 'Current source processing is not permitted',
            });
          }
          if (yield* sourceSyncProcessingSelected) {
            yield* requireSourceSyncProcessingPermit(scope, input, decision, DateTime.formatIso(yield* DateTime.now));
          }
          return decision;
        },
      ),
      checkSet: Effect.fn('CommerceSourceProcessingEligibility.checkSet')(
        function* checkSet(scope, inputs, operationRequirementKey) {
          if (inputs.length === 0) {
            return [];
          }
          const requests = yield* Effect.forEach(
            inputs,
            (input) =>
              Schema.decodeUnknownEffect(SourceProcessingEligibilityRequestSchema, { onExcessProperty: 'error' })({
                ...input,
                consumerModuleId: 'commerce.customer-context',
              }),
            { concurrency: 1 },
          ).pipe(Effect.mapError(rejected('UNAVAILABLE', 'The exact current source processing request is invalid')));
          const payload = { requests };
          // Declared in-transaction evidence call (demo divergence, DEPLOYMENT.md); see ../declared-evidence-calls.ts.
          const response = yield* acquireDelegatedGatewayContext(
            {
              audience: 'privacy',
              callingAppId: 'commerce-customer-context',
              legalEntityScope: 'subject',
              requestCorrelation: scope.correlationId,
              subject: commerceSourceDelegationSubject(
                scope,
                'privacy.core.source-processing-eligibility-set.read',
                payload,
                operationRequirementKey,
              ),
            },
            crypto,
          ).pipe(
            Effect.flatMap((issued) =>
              executeSourceProcessingEligibilitySetWithAuthorization(payload, issued.authorization, scope.correlationId, {
                baseUrl: new URL(issued.apiBaseUrl),
                compositionRevision: issued.compositionRevision,
              }),
            ),
            commerceCustomerContextEvidenceCall.sourceProcessingEligibility,
            Effect.mapError(rejected('UNAVAILABLE', 'Current source Privacy authority is unavailable')),
          );
          const { decisions } = yield* Schema.decodeUnknownEffect(SourceProcessingEligibilitySetResponseSchema)(
            response,
          ).pipe(Effect.mapError(rejected('UNAVAILABLE', 'Privacy returned invalid source processing evidence')));
          if (decisions.length !== inputs.length) {
            return yield* rejected('UNAVAILABLE', 'Privacy returned invalid source processing evidence')();
          }
          const sourceSync = yield* sourceSyncProcessingSelected;
          const now = DateTime.formatIso(yield* DateTime.now);
          return yield* Effect.forEach(
            decisions,
            Effect.fnUntraced(function* judge(decision, index) {
              const input = inputs[index];
              if (decision.outcome !== 'ALLOWED' || input === undefined) {
                return yield* new CommerceSourceProcessingRejected({
                  code: 'DENIED',
                  reason: 'Current source processing is not permitted',
                });
              }
              if (sourceSync) {
                yield* requireSourceSyncProcessingPermit(scope, input, decision, now);
              }
              return decision;
            }),
            { concurrency: 1 },
          );
        },
      ),
    };
  }),
);
