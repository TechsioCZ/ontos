/*
 * D-3 (Unit 12 Stage D, #938 F22-F26): the public-boundary HTTP contract of the Tax correction preview. It follows
 * the direct-handler pattern of `inventory/tests/unit/current-relevant-stock-position-set-http.test.ts` L258-330: a
 * real `HttpApiBuilder` handler built from the generated registration and problems, run through
 * `HttpRouter.toWebHandler` and exercised by the published client over a scripted `fetch`. For every case,
 * `ReadRuntime` is a real `makeReadTestHarness` runtime, like the inventory test: the governed-read permission
 * decision, result-schema validation and evidence write all execute for real through the actual Core Read
 * lifecycle, never a hand-stubbed call straight into `readTaxCorrectionPreview`. The preview's own services are
 * `Record<never, never>` (it reads no TAX state), so `executeOwnerQuery` dies the test if it is ever called.
 * `ReadRuntime` is a separate hand-stubbed `ReadHandlerUnavailable` failure only for the outage contrast (d). This
 * proves the wire-level D4 mapping — `HISTORY_OWNER_UNAVAILABLE` is a typed 200, never the retryable 503
 * `TaxCorrectionPreviewUnavailableProblem` reserved for TAX's own runtime unavailability (D4, #938 F22-F26) —
 * without reconstructing the full application composition/authentication pipeline a real deployment provides.
 *
 * Every case, including (c) over the real Billing Document Terms, goes through the published HTTP client:
 * `HttpApiBuilder` decodes the payload exactly once and Read Runtime only validates its type side, so the
 * `DateTimeUtcFromString` times of the Accepted Tax Terms are never re-decoded from a value.
 */
import { ContextAccess, ReadHandlerUnavailable, ReadRuntime, toContextPermissionAccessKey } from '@app/core-runtime';
import type { ContextAccessService, OperationalScope, ReadRuntimeService } from '@app/core-runtime';
import { makeGovernedReadHttpHandler } from '@app/core-runtime/http/governed-read';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { RequestSchemaProblemLive } from '@app/shared-contracts/server/http-error-seam';
import { HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { Context, DateTime, Effect, Layer, Result, Schema } from 'effect';
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
import { taxCorrectionPreviewRead } from '../../src/api/tax-correction-preview.read.ts';
import { TaxDependencyUnavailableSchema } from '../../src/domain/tax-non-success-outcome.ts';
import {
  TaxCorrectionDeltaSchema,
  TaxCorrectionHistoricalInputUnresolvedSchema,
} from '../../src/domain/tax-correction-delta.ts';
import { exactDecimal } from '../unit/tax-domain-fixtures.ts';
import type { TaxCorrectionPreviewRequestContractSchema } from '../../shared/domain/tax-correction-preview-contracts.ts';
import { acceptedTaxTermsInput } from '../unit/tax-correction-fixtures.ts';

// The trusted principal's `legalEntityId`/`tenantId` decode as UUIDs (`decodeTrustedPrincipalContext`), distinct
// from the Tax domain's own `BoundedIdentifier` `sellingLegalEntityRef`/`tenantId`; the fixture's Decision is
// patched below to match.
const SELLING_LEGAL_ENTITY_ID = '30000000-0000-4000-8000-000000000003';
const TENANT_ID = '40000000-0000-4000-8000-000000000004';

const scope = {
  authBindingId: '10000000-0000-4000-8000-000000000001',
  authContextRef: 'tax-correction-preview-http-test',
  authMethod: 'session',
  correlationId: 'tax-correction-preview-http-test',
  legalEntityId: SELLING_LEGAL_ENTITY_ID,
  principalId: '20000000-0000-4000-8000-000000000002',
  tenantId: TENANT_ID,
} satisfies OperationalScope;

const historyOwnerUnavailable = { _tag: 'HISTORY_OWNER_UNAVAILABLE' } as const;
const recordUnavailable = { _tag: 'ORIGINAL_RECORD_UNAVAILABLE', reason: 'MISSING' } as const;
const baseBillingTerms = acceptedTaxTermsInput([{ lineValue: '999.90', occurrenceId: 'o-1', quantity: '10' }]);
const billingTerms = {
  ...baseBillingTerms,
  finalTax: {
    ...baseBillingTerms.finalTax,
    decision: {
      ...baseBillingTerms.finalTax.decision,
      purchaseBinding: {
        ...baseBillingTerms.finalTax.decision.purchaseBinding,
        sellingLegalEntityRef: SELLING_LEGAL_ENTITY_ID,
        tenantId: TENANT_ID,
      },
    },
  },
};

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
 * A real `ReadRuntime` from `makeReadTestHarness`, scoped to an allowed `permissionDecision` and
 * `ownerAuthorizationDecision`, with its `ContextAccess.contextPermissions` granted for the preview's
 * `tax.governed.read` module-scoped `context_permission` authorization (the harness's own
 * `businessPermissionDecision` option only covers `business_permission`/`assortment_permission` targets, not this
 * entrypoint's — `contextPermissions` has no dedicated harness option, so it is granted directly on the harness's
 * own `ContextAccess` service). `executeOwnerQuery` dies the test if called: the preview's `services` are
 * `Record<never, never>`, so there is no owner SQL to script (#938 F22-F26).
 */
const grantAllContextPermissions: ContextAccessService['contextPermissions'] = ({ targets }) =>
  Effect.succeed(
    targets.map((target) => ({ decision: 'allowed' as const, key: toContextPermissionAccessKey(target) })),
  );

const makeGrantedHarness = Effect.fn('TaxCorrectionPreviewTest.makeGrantedHarness')(function* makeGrantedHarness() {
  const harness = yield* makeReadTestHarness({
    executeOwnerQuery: () => Effect.die('The Tax correction preview reads no owner state'),
    operationTime: DateTime.toDateUtc(DateTime.makeUnsafe('2026-10-05T12:00:00.000Z')),
    ownerAuthorizationDecision: 'allowed',
    permissionDecision: 'allowed',
    scope,
  });
  const builtContext = yield* Layer.build(harness.layer);
  const contextAccess = Context.get(builtContext, ContextAccess);
  // The harness's own `ContextAccessService` has no dedicated option for `context_permission` grants, so this
  // extends the mutable service object the harness already built (not a frozen value) directly.
  Object.assign(contextAccess, { contextPermissions: grantAllContextPermissions });
  return harness;
});

const outageRuntime: ReadRuntimeService = {
  runRead: () =>
    Effect.fail(new ReadHandlerUnavailable({ code: 'read_handler_unavailable', reason: 'controlled outage' })),
};

const makeTaxCorrectionPreviewServer = (runtime: ReadRuntimeService) =>
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
      const requestContext = Context.make(ReadRuntime, runtime);
      return {
        requestContext,
        server: HttpRouter.toWebHandler(
          HttpApiBuilder.layer(TaxCorrectionPreviewApi).pipe(
            Layer.provide(handlers),
            Layer.provideMerge(RequestSchemaProblemLive),
            Layer.provide(Layer.succeed(ReadRuntime, runtime)),
            Layer.provide(HttpServer.layerServices),
          ),
          { disableLogger: true },
        ),
      };
    }),
    ({ server }) => Effect.promise(() => server.dispose()).pipe(Effect.orDie),
  );

/** The wire form a caller sends; the request schema also admits its already-decoded type side. */
type PreviewRequestInput = typeof TaxCorrectionPreviewRequestContractSchema.Encoded;

const decodeRequest = Schema.decodeUnknownSync(TaxCorrectionPreviewRequestSchema);

const run = (requestInput: PreviewRequestInput, runtime: ReadRuntimeService) =>
  Effect.gen(function* execute() {
    const { requestContext, server } = yield* makeTaxCorrectionPreviewServer(runtime);
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
      const harness = yield* makeGrantedHarness();
      const { result, statuses } = yield* run(
        { acceptedTaxTerms: historyOwnerUnavailable, declaredPurpose: correctionDeclaredPurpose },
        harness.runtime,
      );
      expect(statuses).toEqual([200]);
      expect(Result.isSuccess(result)).toBe(true);
      Result.match(result, {
        onFailure: () => {},
        onSuccess: (success) => expect(Schema.is(TaxDependencyUnavailableSchema)(success)).toBe(true),
      });
      expect(harness.snapshot().evidenceWrites).toBe(1);
    }),
  );

  it.effect('b. ORIGINAL_RECORD_UNAVAILABLE MISSING stays TAX_HISTORICAL_INPUT_UNRESOLVED, distinct from D4', () =>
    Effect.gen(function* originalRecordUnavailable() {
      const harness = yield* makeGrantedHarness();
      const { result, statuses } = yield* run(
        { acceptedTaxTerms: recordUnavailable, declaredPurpose: { _tag: 'HISTORICAL_READ' } },
        harness.runtime,
      );
      expect(statuses).toEqual([200]);
      expect(Result.isSuccess(result)).toBe(true);
      Result.match(result, {
        onFailure: () => {},
        onSuccess: (success) => expect(Schema.is(TaxCorrectionHistoricalInputUnresolvedSchema)(success)).toBe(true),
      });
      expect(harness.snapshot().evidenceWrites).toBe(1);
    }),
  );

  it.effect('c. a retry after recovery over the real Billing Document previews a Tax Correction Delta', () =>
    Effect.gen(function* retryAfterRecovery() {
      const harness = yield* makeGrantedHarness();
      const { result, statuses } = yield* run(
        { acceptedTaxTerms: billingTerms, declaredPurpose: correctionDeclaredPurpose },
        harness.runtime,
      );
      expect(statuses).toEqual([200]);
      expect(Result.isSuccess(result)).toBe(true);
      Result.match(result, {
        onFailure: () => {},
        onSuccess: (success) => expect(Schema.is(TaxCorrectionDeltaSchema)(success)).toBe(true),
      });
      expect(harness.snapshot().evidenceWrites).toBe(1);
    }),
  );

  it.effect("d. a ReadRuntime outage is TAX's own 503, not the D4 mapping", () =>
    Effect.gen(function* ownerOutage() {
      const { result, statuses } = yield* run(
        { acceptedTaxTerms: historyOwnerUnavailable, declaredPurpose: correctionDeclaredPurpose },
        outageRuntime,
      );
      expect(statuses).toEqual([503]);
      expect(Result.isFailure(result)).toBe(true);
      Result.match(result, {
        onFailure: (failure) => expect(Schema.is(TaxCorrectionPreviewUnavailableProblemSchema)(failure)).toBe(true),
        onSuccess: () => {},
      });
    }),
  );

  it.effect('e. every request writes its evidence exactly once', () =>
    Effect.gen(function* callsOnce() {
      for (const request of [
        { acceptedTaxTerms: historyOwnerUnavailable, declaredPurpose: correctionDeclaredPurpose },
        { acceptedTaxTerms: recordUnavailable, declaredPurpose: { _tag: 'HISTORICAL_READ' } },
        { acceptedTaxTerms: billingTerms, declaredPurpose: correctionDeclaredPurpose },
      ] as const) {
        const harness = yield* makeGrantedHarness();
        yield* run(request, harness.runtime);
        expect(harness.snapshot().evidenceWrites).toBe(1);
      }
    }),
  );
});
