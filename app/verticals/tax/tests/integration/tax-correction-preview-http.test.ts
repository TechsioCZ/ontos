/*
 * D-3 (Unit 12 Stage D, #938 F22-F26): the public-boundary HTTP contract of the Tax correction preview. It follows
 * the direct-handler pattern of `inventory/tests/unit/current-relevant-stock-position-set-http.test.ts` L258-330: a
 * real `HttpApiBuilder` handler built from the generated registration and problems, run through
 * `HttpRouter.toWebHandler` and exercised by the published client over a scripted `fetch`. No database: the
 * preview's own services are `Record<never, never>` (it reads no TAX state), so `ReadRuntime` is stubbed to call the
 * real `readTaxCorrectionPreview` handler directly for the success cases and to fail as `ReadHandlerUnavailable`
 * for the outage contrast (d). This proves the wire-level D4 mapping — `HISTORY_OWNER_UNAVAILABLE` is a typed 200,
 * never the retryable 503 `TaxCorrectionPreviewUnavailableProblem` reserved for TAX's own runtime unavailability —
 * without reconstructing the full governed-read evidence/composition pipeline that a real deployment provides.
 */
import type { OperationalScope } from '@app/core-runtime';
import { ReadHandlerUnavailable, ReadRuntime } from '@app/core-runtime';
import { makeGovernedReadHttpHandler } from '@app/core-runtime/http/governed-read';
import { RequestSchemaProblemLive } from '@app/shared-contracts/server/http-error-seam';
import { HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { Context, Effect, Layer, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { FetchHttpClient } from 'effect/unstable/http';

import {
  TaxCorrectionPreviewApi,
  TaxCorrectionPreviewAuthenticationProblemSchema,
  TaxCorrectionPreviewForbiddenProblemSchema,
  TaxCorrectionPreviewInternalProblemSchema,
  TaxCorrectionPreviewInvalidProblemSchema,
  TaxCorrectionPreviewNotFoundProblemSchema,
  TaxCorrectionPreviewPolicyConflictProblemSchema,
  TaxCorrectionPreviewPolicyProblemSchema,
  TaxCorrectionPreviewRequestSchema,
  TaxCorrectionPreviewUnavailableProblemSchema,
} from '../../shared/apis/tax-correction-preview.ts';
import { makeGovernedReadProblems } from '@app/shared-contracts/server/effect-bff-runtime';
import { executeTaxCorrectionPreviewWithAuthorization } from '../../src/api/tax-correction-preview-client.ts';
import { readTaxCorrectionPreview, taxCorrectionPreviewRead } from '../../src/api/tax-correction-preview.read.ts';
import { TaxDependencyUnavailableSchema } from '../../src/domain/tax-non-success-outcome.ts';
import {
  TaxCorrectionDeltaSchema,
  TaxCorrectionHistoricalInputUnresolvedSchema,
} from '../../src/domain/tax-correction-delta.ts';
import { exactDecimal } from '../unit/tax-domain-fixtures.ts';
import { acceptedTaxTermsInput } from '../unit/tax-correction-fixtures.ts';

const scope = {
  authContextRef: 'tax-correction-preview-http-test',
  authMethod: 'session',
  correlationId: 'tax-correction-preview-http-test',
  legalEntityId: 'selling-legal-entity-1',
  principalId: '20000000-0000-4000-8000-000000000002',
  tenantId: 'tenant-1',
} satisfies OperationalScope;

const historyOwnerUnavailable = { _tag: 'HISTORY_OWNER_UNAVAILABLE' } as const;
const recordUnavailable = { _tag: 'ORIGINAL_RECORD_UNAVAILABLE', reason: 'MISSING' } as const;
const billingTerms = acceptedTaxTermsInput([{ lineValue: '999.90', occurrenceId: 'o-1', quantity: '10' }]);

const correctionDeclaredPurpose = {
  _tag: 'CORRECTION',
  correctionEventRef: 'return-1',
  correctionReason: 'CUSTOMER_RETURN',
  units: [
    {
      changes: [{ _tag: 'QUANTITY', quantityDelta: exactDecimal('-1') }],
      expectedPreviousState: { _tag: 'NO_ACCEPTED_CORRECTION' },
      taxableSupplyUnitId: 'taxable-supply-unit:o-1',
    },
  ],
} as const;

const problems = makeGovernedReadProblems({
  authentication: TaxCorrectionPreviewAuthenticationProblemSchema,
  forbidden: TaxCorrectionPreviewForbiddenProblemSchema,
  internal: TaxCorrectionPreviewInternalProblemSchema,
  invalid: TaxCorrectionPreviewInvalidProblemSchema,
  notFound: TaxCorrectionPreviewNotFoundProblemSchema,
  policyConflict: TaxCorrectionPreviewPolicyConflictProblemSchema,
  policyIneligible: TaxCorrectionPreviewPolicyProblemSchema,
  unavailable: TaxCorrectionPreviewUnavailableProblemSchema,
});

/**
 * Minimal `ReadRuntime` that invokes the real domain handler directly instead of the full owner-query/evidence
 * lifecycle (the preview's `services` are `Record<never, never>`, so there is no owner SQL to script). It counts
 * every call as a stand-in for "evidence written once per read" (D-3e), since this stub persists no evidence row
 * itself.
 */
const decodeRequest = Schema.decodeUnknownSync(TaxCorrectionPreviewRequestSchema);
const isTaxCorrectionPreviewRequest = Schema.is(TaxCorrectionPreviewRequestSchema);

/**
 * By the time `makeGovernedReadHttpHandler` calls `ReadRuntime.runRead`, the HTTP route's own payload schema has
 * already decoded the wire body into `TaxCorrectionPreviewRequest`; this narrows the stub's untyped `input` back to
 * that real registration type instead of a hand cast, dying loudly if the route ever stopped decoding first.
 */
const makeStubbedRuntime = (options: { readonly ownerUnavailable?: boolean }) => {
  let calls = 0;
  return {
    calls: () => calls,
    runtime: {
      runRead: (invocation: { readonly input: unknown }) => {
        calls += 1;
        if (options.ownerUnavailable === true) {
          return Effect.fail(
            new ReadHandlerUnavailable({ code: 'read_handler_unavailable', reason: 'controlled outage' }),
          );
        }
        if (!isTaxCorrectionPreviewRequest(invocation.input)) {
          return Effect.die('The HTTP route must decode the payload before ReadRuntime.runRead is called');
        }
        return readTaxCorrectionPreview(invocation.input, {
          readKey: 'commerce.tax.api.tax-correction-preview',
          scope,
          services: {},
        }).pipe(Effect.map(({ result }) => result));
      },
    },
  };
};

const makeTaxCorrectionPreviewServer = (stubbedRuntime: ReturnType<typeof makeStubbedRuntime>['runtime']) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const handler = makeGovernedReadHttpHandler({
        authenticatePrincipal: () => Effect.succeed(scope),
        problems,
        registration: taxCorrectionPreviewRead,
      });
      const handlers = HttpApiBuilder.group(TaxCorrectionPreviewApi, 'taxCorrectionPreview', (routes) =>
        routes.handle('execute', handler),
      );
      const requestContext = Context.make(ReadRuntime, stubbedRuntime);
      return {
        requestContext,
        server: HttpRouter.toWebHandler(
          HttpApiBuilder.layer(TaxCorrectionPreviewApi).pipe(
            Layer.provide(handlers),
            Layer.provideMerge(RequestSchemaProblemLive),
            Layer.provide(Layer.succeed(ReadRuntime, stubbedRuntime)),
            Layer.provide(HttpServer.layerServices),
          ),
          { disableLogger: true },
        ),
      };
    }),
    ({ server }) => Effect.promise(() => server.dispose()).pipe(Effect.orDie),
  );

type PreviewRequestInput = typeof TaxCorrectionPreviewRequestSchema.Encoded;

const run = (requestInput: PreviewRequestInput, stubbedRuntime: ReturnType<typeof makeStubbedRuntime>['runtime']) =>
  Effect.gen(function* execute() {
    const { requestContext, server } = yield* makeTaxCorrectionPreviewServer(stubbedRuntime);
    const statuses: number[] = [];
    const routerFetch: typeof fetch = (url, init) =>
      server.handler(new Request(url, init), requestContext).then((response) => {
        statuses.push(response.status);
        return response;
      });
    const result = yield* executeTaxCorrectionPreviewWithAuthorization(
      decodeRequest(requestInput),
      'Bearer controlled',
      'tax-correction-preview-http-test',
      { baseUrl: 'https://tax.example' },
    ).pipe(Effect.provideService(FetchHttpClient.Fetch, routerFetch), Effect.result);
    return { result, statuses };
  });

describe('Tax correction preview HTTP request contract (D-3, #938 F22-F26)', () => {
  it.effect('a. HISTORY_OWNER_UNAVAILABLE + CORRECTION is a typed 200, never the unavailable problem', () =>
    Effect.gen(function* dependencyUnavailableCorrection() {
      const { runtime } = makeStubbedRuntime({});
      const { result, statuses } = yield* run(
        { acceptedTaxTerms: historyOwnerUnavailable, declaredPurpose: correctionDeclaredPurpose },
        runtime,
      );
      expect(statuses).toEqual([200]);
      expect(Result.isSuccess(result)).toBe(true);
      Result.match(result, {
        onFailure: () => {},
        onSuccess: (success) => expect(Schema.is(TaxDependencyUnavailableSchema)(success)).toBe(true),
      });
    }),
  );

  it.effect('b. ORIGINAL_RECORD_UNAVAILABLE MISSING stays TAX_HISTORICAL_INPUT_UNRESOLVED, distinct from D4', () =>
    Effect.gen(function* originalRecordUnavailable() {
      const { runtime } = makeStubbedRuntime({});
      const { result, statuses } = yield* run(
        { acceptedTaxTerms: recordUnavailable, declaredPurpose: { _tag: 'HISTORICAL_READ' } },
        runtime,
      );
      expect(statuses).toEqual([200]);
      expect(Result.isSuccess(result)).toBe(true);
      Result.match(result, {
        onFailure: () => {},
        onSuccess: (success) => expect(Schema.is(TaxCorrectionHistoricalInputUnresolvedSchema)(success)).toBe(true),
      });
    }),
  );

  it.effect('c. a retry after recovery over the real Billing Document previews a Tax Correction Delta', () =>
    Effect.gen(function* retryAfterRecovery() {
      const { runtime } = makeStubbedRuntime({});
      const { result, statuses } = yield* run(
        { acceptedTaxTerms: billingTerms, declaredPurpose: correctionDeclaredPurpose },
        runtime,
      );
      expect(statuses).toEqual([200]);
      expect(Result.isSuccess(result)).toBe(true);
      Result.match(result, {
        onFailure: () => {},
        onSuccess: (success) => expect(Schema.is(TaxCorrectionDeltaSchema)(success)).toBe(true),
      });
    }),
  );

  it.effect("d. a ReadRuntime outage is TAX's own 503, not the D4 mapping", () =>
    Effect.gen(function* ownerOutage() {
      const { runtime } = makeStubbedRuntime({ ownerUnavailable: true });
      const { result, statuses } = yield* run(
        { acceptedTaxTerms: historyOwnerUnavailable, declaredPurpose: correctionDeclaredPurpose },
        runtime,
      );
      expect(statuses).toEqual([503]);
      expect(Result.isFailure(result)).toBe(true);
      Result.match(result, {
        onFailure: (failure) => expect(Schema.is(TaxCorrectionPreviewUnavailableProblemSchema)(failure)).toBe(true),
        onSuccess: () => {},
      });
    }),
  );

  it.effect('e. every request reaches the handler exactly once', () =>
    Effect.gen(function* callsOnce() {
      for (const request of [
        { acceptedTaxTerms: historyOwnerUnavailable, declaredPurpose: correctionDeclaredPurpose },
        { acceptedTaxTerms: recordUnavailable, declaredPurpose: { _tag: 'HISTORICAL_READ' } },
        { acceptedTaxTerms: billingTerms, declaredPurpose: correctionDeclaredPurpose },
      ] as const) {
        const stubbed = makeStubbedRuntime({});
        yield* run(request, stubbed.runtime);
        expect(stubbed.calls()).toBe(1);
      }
    }),
  );
});
