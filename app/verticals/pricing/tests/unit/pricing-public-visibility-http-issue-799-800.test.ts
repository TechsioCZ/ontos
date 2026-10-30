import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { Effect, HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import {
  CurrentPricingDecisionApi,
  CurrentPricingDecisionAuthenticationProblemSchema,
  CurrentPricingDecisionForbiddenProblemSchema,
  CurrentPricingDecisionInternalProblemSchema,
  CurrentPricingDecisionInvalidProblemSchema,
  CurrentPricingDecisionNotFoundProblemSchema,
  CurrentPricingDecisionPolicyConflictProblemSchema,
  CurrentPricingDecisionPolicyProblemSchema,
  CurrentPricingDecisionRequestSchema,
  CurrentPricingDecisionUnavailableProblemSchema,
  projectCurrentPricingDecisionResponse,
} from '@app/pricing-contracts/current-pricing-decision';
import type {
  CurrentPricingDecisionRequest,
  CurrentPricingDecisionResponse,
} from '@app/pricing-contracts/current-pricing-decision';
import { makeGovernedReadProblems } from '@app/shared-contracts/server/effect-bff-runtime';
import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { makeIssue779Scenario } from './support/issue-779-line-value.fixture.ts';

const problems = makeGovernedReadProblems({
  authentication: CurrentPricingDecisionAuthenticationProblemSchema,
  forbidden: CurrentPricingDecisionForbiddenProblemSchema,
  internal: CurrentPricingDecisionInternalProblemSchema,
  invalid: CurrentPricingDecisionInvalidProblemSchema,
  notFound: CurrentPricingDecisionNotFoundProblemSchema,
  policyConflict: CurrentPricingDecisionPolicyConflictProblemSchema,
  policyIneligible: CurrentPricingDecisionPolicyProblemSchema,
  unavailable: CurrentPricingDecisionUnavailableProblemSchema,
});

type PublicProblem =
  | ReturnType<typeof problems.authentication>
  | ReturnType<typeof problems.forbidden>
  | ReturnType<typeof problems.internal>
  | ReturnType<typeof problems.invalid>
  | ReturnType<typeof problems.notFound>
  | ReturnType<typeof problems.policyConflict>
  | ReturnType<typeof problems.policyIneligible>
  | ReturnType<typeof problems.unavailable>;

const privateMarkers = [
  'internal-authority:pricing-operator',
  'owner-proof:private:799',
  'source-lookup:diagnostic:799',
  'reconciliation:hold:799',
  'margin:internal:799',
] as const;

const withPrivateCause = <Problem extends PublicProblem>(problem: Problem): Problem =>
  Object.defineProperty(problem, 'cause', {
    configurable: true,
    value: {
      authority: privateMarkers[0],
      margin: privateMarkers[4],
      proofRef: privateMarkers[1],
      reconciliation: privateMarkers[3],
      sourceLookup: privateMarkers[2],
    },
  });

const makeRuntime = (response: Effect.Effect<CurrentPricingDecisionResponse, PublicProblem>) =>
  assembleEffectBffRuntime({
    api: CurrentPricingDecisionApi,
    handlers: HttpApiBuilder.group(CurrentPricingDecisionApi, 'currentPricingDecision', (handlers) =>
      handlers.handle('execute', () => response),
    ),
  });

const requestFor = (payload: CurrentPricingDecisionRequest) =>
  new Request('https://pricing.ontos.test/reads/current-pricing-decision', {
    body: JSON.stringify(payload),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const assertNoPrivateMarkers = (serialized: string): void => {
  for (const marker of privateMarkers) {
    expect(serialized).not.toContain(marker);
  }
  expect(serialized).not.toMatch(
    /authority|breakdown|factRevisionRef|lookup|margin|ownerSetRevisionRef|proof|reconciliation|sourceEvidence|verificationRef/iu,
  );
};

describe('Pricing customer HTTP visibility (#799/#800)', () => {
  it.live('publishes the Guest customer allowlist and exact pre-Tax commercial total over HTTP', () =>
    Effect.gen(function* customerSuccessTransport() {
      const { compositionRequest } = yield* makeIssue779Scenario();
      const guest = {
        guestEvidenceRef: 'guest-evidence:issue-799',
        guestSessionRef: 'guest-session:issue-799',
        kind: 'GUEST' as const,
      };
      const decision = {
        ...compositionRequest.decision,
        purchasingContext: {
          ...compositionRequest.decision.purchasingContext,
          actor: guest,
          subject: guest,
        },
      };
      const payload = yield* Schema.decodeEffect(CurrentPricingDecisionRequestSchema)({ decision, subject: guest });
      const line = yield* Effect.suspend(() => {
        const [candidate] = decision.lines;
        return candidate === undefined
          ? Effect.die('The customer visibility fixture requires one Pricing Line')
          : Effect.succeed(candidate);
      });
      const unsafeSafeProjectionSource = {
        candidateRef: 'candidate:issue-799',
        currencyCode: 'CZK',
        internalMargin: privateMarkers[4],
        lines: [
          {
            occurrenceId: line.occurrenceId,
            publishedLineValue: { amount: '70', currencyCode: 'CZK' },
          },
        ],
        monetaryBoundary: 'PRE_TAX' as const,
        pricingNetCommercialTotal: { amount: '70', currencyCode: 'CZK' },
        sourceEvidence: privateMarkers[1],
      };
      const safe = projectCurrentPricingDecisionResponse(unsafeSafeProjectionSource);
      const runtime = makeRuntime(Effect.succeed(safe));
      const server = yield* Effect.acquireRelease(
        Effect.sync(() => runtime.createHandler()),
        (handler) => Effect.promise(() => handler.dispose()),
      );
      const response = yield* Effect.promise(() => server.handler(requestFor(payload)));
      const body = yield* Effect.promise(() => response.json());
      const serialized = yield* encodeJson(body);

      expect(response.status).toBe(200);
      expect(body).toEqual({
        candidate: { occurrenceIds: [line.occurrenceId] },
        outcome: 'PRICE_RESOLVED',
        projectionVersion: 'CURRENT_PRICING_DECISION_CUSTOMER_V1',
        result: {
          currencyCode: 'CZK',
          lines: [
            {
              occurrenceId: line.occurrenceId,
              publishedPreTaxAmount: { amount: '70', currencyCode: 'CZK' },
            },
          ],
          monetaryBoundary: 'PRE_TAX',
          total: { amount: '70', currencyCode: 'CZK' },
          totalMethod: 'EXACT_SUM_OF_ROUNDED_LINES',
        },
        retryable: false,
      });
      assertNoPrivateMarkers(serialized);
    }),
  );

  it.live('sanitizes every declared public Problem Details class at the HTTP boundary', () =>
    Effect.gen(function* customerProblemTransport() {
      const { compositionRequest } = yield* makeIssue779Scenario();
      const payload = yield* Schema.decodeEffect(CurrentPricingDecisionRequestSchema)({
        decision: compositionRequest.decision,
        subject: compositionRequest.decision.purchasingContext.subject,
      });
      const cases = [
        [400, problems.invalid()],
        [401, problems.authentication()],
        [403, problems.forbidden()],
        [404, problems.notFound()],
        [409, problems.policyConflict()],
        [422, problems.policyIneligible()],
        [500, problems.internal()],
        [503, problems.unavailable()],
      ] as const;

      for (const [status, publicProblem] of cases) {
        const runtime = makeRuntime(Effect.fail(withPrivateCause(publicProblem)));
        const server = yield* Effect.acquireRelease(
          Effect.sync(() => runtime.createHandler()),
          (handler) => Effect.promise(() => handler.dispose()),
        );
        const response = yield* Effect.promise(() => server.handler(requestFor(payload)));
        const body = yield* Effect.promise(() => response.json());
        const serialized = yield* encodeJson(body);

        expect(response.status).toBe(status);
        expect(response.headers.get('content-type')).toContain('application/problem+json');
        expect(body).toMatchObject({ status });
        expect(Object.keys(body).toSorted()).toEqual(
          status === 503
            ? ['_tag', 'detail', 'retryable', 'status', 'title', 'type']
            : ['_tag', 'detail', 'status', 'title', 'type'],
        );
        assertNoPrivateMarkers(serialized);
      }
    }),
  );
});
