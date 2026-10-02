import { ActionAlreadyCommitted, ActionCommitIndeterminate } from '@app/core-runtime';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { CatalogSelectionOwnerAssessmentResultSchema } from '@app/catalog/domain/catalog-selection-owner-contract';
import { ScheduledPriceRevisionSchema } from '@app/pricing-contracts/domain/price-schedule';
import {
  PriceSourceAssertionInputSchema,
  PriceSourceProvenanceSchema,
} from '@app/pricing-contracts/domain/price-source-provenance';
import { DateTime, Effect, Predicate, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { FetchHttpClient } from 'effect/unstable/http';

import { PriceResultLookupRequestSchema } from '../../shared/apis/price-result-lookup.ts';
import { mapDefinePriceActionProblem } from '../../api/define-price-action-problems.ts';
import { mapRevisePriceActionProblem } from '../../api/revise-price-action-problems.ts';
import { DefinePricePayloadSchema, definePriceAction } from '../../src/actions/define-price.action.ts';
import type { DefinePriceActionServices } from '../../src/actions/define-price.action.ts';
import {
  RevisePriceAcknowledgementRequired,
  RevisePriceConflict,
  RevisePricePayloadSchema,
  applyPriceRevision,
  revisePriceAction,
} from '../../src/actions/revise-price.action.ts';
import {
  SetSupportedCurrenciesPayloadSchema,
  SupportedCurrenciesAdministrationRejected,
  applySupportedCurrencies,
  setSupportedCurrenciesAction,
} from '../../src/actions/set-supported-currencies.action.ts';
import { executePriceScheduleWithAuthorization } from '../../src/api/price-schedule-client.ts';
import { readPriceResult } from '../../src/api/price-result-lookup.read.ts';
import type { SetCurrencySupportCommand } from '../../src/persistence/currency-support-persistence.ts';
import type {
  DefinePricePersistenceOutcome,
  PricePersistence,
  RevisePricePersistenceOutcome,
} from '../../src/services/price-persistence.service.ts';
import {
  ExternalPriceInputBoundaryFactory,
  makeExternalPriceInputBoundary,
} from '../../src/services/external-price-input-boundary.service.ts';
import { preparePriceSourceEvidence } from '../../src/services/price-source-provenance.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const principalId = '33333333-3333-4333-8333-333333333333';
const operationAt = '2026-09-27T12:00:00.000Z';
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const priceRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.pricing.price' as const,
  tenantId,
};
const productRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'commerce.catalog.product' as const,
  tenantId,
};
const variantRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '66666666-6666-4666-8666-666666666666',
  resourceType: 'commerce.catalog.variant' as const,
  tenantId,
};
const unitBasis = {
  quantity: '1',
  unitRef: {
    moduleId: 'commerce.catalog' as const,
    resourceId: '77777777-7777-4777-8777-777777777777',
    resourceType: 'commerce.catalog.product-unit' as const,
    tenantId,
  },
};
const identityKey = {
  catalogSelection: { productRef, variantRef },
  commercialScope: { channelId: 'B2C' as const, marketId: 'cz-launch', sellingLegalEntityId: legalEntityId },
  currencyCode: 'CZK',
  priceGroupSelector: { kind: 'NO_GROUP' as const },
  unitBasis,
};
const sourceAssertion = Schema.decodeSync(PriceSourceAssertionInputSchema)({
  lineage: { kind: 'INITIAL' },
  mapping: { mappingContractRef: 'erp-price-v2', mappingContractVersion: '2' },
  originalAssertion: {
    monetaryAmount: { amount: '100', currencyCode: 'CZK' },
    monetaryBoundary: 'PRE_TAX',
    unitBasis,
  },
  sourceAssertionId: '88888888-8888-4888-8888-888888888888',
  sourceAuthority: { sourceAuthorityRef: 'pricing-owner', sourceAuthorityVersion: '7' },
  sourceRecord: {
    sourceChangeCorrelation: 'change-797',
    sourceRecordRef: 'price-row-797',
    sourceRecordVersion: '1',
    sourceSystem: { ownerModuleId: 'commerce.pricing', sourceSystemRef: 'erp-eu' },
  },
  timing: {
    importedAt: '2026-09-27T12:00:00.500Z',
    ownerBusinessEffectiveAt: operationAt,
    sourceEffectiveAt: '2026-09-27T11:59:00.000Z',
  },
});
const currentPeriod = {
  effectiveFrom: '2026-09-01T00:00:00.000Z',
  effectiveTo: '2026-10-01T00:00:00.000Z',
};
const currentRevision = Schema.decodeSync(ScheduledPriceRevisionSchema)({
  definition: {
    identityKey,
    priceRef,
    revision: {
      effectiveFrom: currentPeriod.effectiveFrom,
      monetaryAmount: { amount: '100', currencyCode: 'CZK' },
      monetaryBoundary: 'PRE_TAX',
      revision: 1,
      revisionId: '99999999-9999-4999-8999-999999999999',
    },
  },
  effectivePeriod: currentPeriod,
  lineage: { correctedRevisionId: null, kind: 'INITIAL', previousRevisionId: null },
});
const futureRevision = Schema.decodeSync(ScheduledPriceRevisionSchema)({
  ...currentRevision,
  definition: {
    ...currentRevision.definition,
    revision: {
      ...currentRevision.definition.revision,
      effectiveFrom: '2026-11-01T00:00:00.000Z',
      monetaryAmount: { amount: '120', currencyCode: 'CZK' },
      revision: 2,
      revisionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    },
  },
  effectivePeriod: { effectiveFrom: '2026-11-01T00:00:00.000Z', effectiveTo: null },
  lineage: {
    correctedRevisionId: null,
    kind: 'SCHEDULED',
    previousRevisionId: currentRevision.definition.revision.revisionId,
  },
});
const revisedRevision = Schema.decodeSync(ScheduledPriceRevisionSchema)({
  definition: {
    identityKey,
    priceRef,
    revision: {
      effectiveFrom: operationAt,
      monetaryAmount: { amount: '100', currencyCode: 'CZK' },
      monetaryBoundary: 'PRE_TAX',
      revision: 2,
      revisionId: 'acacacac-acac-4cac-8cac-acacacacacac',
    },
  },
  effectivePeriod: { effectiveFrom: operationAt, effectiveTo: currentPeriod.effectiveTo },
  lineage: {
    correctedRevisionId: null,
    kind: 'VALUE_ONLY_CURRENT',
    previousRevisionId: currentRevision.definition.revision.revisionId,
  },
});
const expectedCurrent = {
  effectivePeriod: currentPeriod,
  priceRef,
  revision: 1,
  revisionId: currentRevision.definition.revision.revisionId,
  scheduleRevision: 7,
};
const revisePayload = Schema.decodeSync(RevisePricePayloadSchema)({
  expectedCurrent,
  intent: 'VALUE_ONLY_CURRENT',
  monetaryAmount: currentRevision.definition.revision.monetaryAmount,
  priceRef,
  reason: 'Reassert the current value only after checking Current state',
  sourceAssertion,
});
const definePayload = Schema.decodeSync(DefinePricePayloadSchema)({
  effectiveFrom: operationAt,
  identityKey,
  monetaryAmount: currentRevision.definition.revision.monetaryAmount,
  priceRef,
  reason: 'Define the exact launch Price',
  sourceAssertion,
});
if (revisePayload.intent !== 'VALUE_ONLY_CURRENT') {
  throw new Error('The acceptance fixture must be a Current value edit');
}
const trusted = {
  actingPrincipalId: principalId,
  actionInvocationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  legalEntityId,
  requestCorrelationId: 'pricing-management-797',
  tenantId,
  trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe(operationAt)),
};
const acknowledgement = {
  actingPrincipalId: principalId,
  fingerprint: 'c'.repeat(64),
  intendedEffectivePeriod: {
    effectiveFrom: operationAt,
    effectiveTo: currentPeriod.effectiveTo,
  },
  intendedMonetaryAmount: revisePayload.monetaryAmount,
  intent: 'VALUE_ONLY_CURRENT' as const,
  presentedFuture: [futureRevision],
  priceRef,
  scheduleRevision: expectedCurrent.scheduleRevision,
  targetRevisionId: expectedCurrent.revisionId,
};
const reviseServices = (revise: PricePersistence['revise']) => ({
  assessExternalPriceInput: (request: Parameters<typeof preparePriceSourceEvidence>[0]) =>
    Effect.succeed(preparePriceSourceEvidence(request)),
  readSchedule: () =>
    Effect.succeed({
      outcome: 'PRICE_SCHEDULE_CURRENT' as const,
      schedule: {
        current: currentRevision,
        future: [futureRevision],
        observedAt: operationAt,
        priceRef,
        revisions: [currentRevision, futureRevision],
        scheduleRevision: expectedCurrent.scheduleRevision,
      },
    }),
  revise,
});

const validCatalogAssessment = Schema.decodeSync(CatalogSelectionOwnerAssessmentResultSchema)({
  assessedAt: operationAt,
  basis: [
    { role: 'PRODUCT', source: { resourceRef: productRef, revision: 1 } },
    { role: 'VARIANT', source: { resourceRef: variantRef, revision: 1 } },
    {
      role: 'PRODUCT_TYPE',
      source: {
        resourceRef: {
          moduleId: 'commerce.catalog',
          resourceId: 'abababab-abab-4bab-8bab-abababababab',
          resourceType: 'commerce.catalog.product-type',
          tenantId,
        },
        revision: 1,
      },
    },
  ],
  membership: {
    attestationId: 'catalog-membership-price-management-v1',
    observedAt: operationAt,
    productRef,
    source: 'CATALOG_OWNER_CURRENT_READ',
    variant: { resourceRef: variantRef, revision: 1 },
  },
  purpose: 'PRICING',
  selection: identityKey.catalogSelection,
  status: 'VALID',
});
const validCommercialContextAssessment = {
  commercialScope: identityKey.commercialScope,
  completenessEvidence: {
    observedAt: DateTime.makeUnsafe(operationAt),
    ownerRevision: 'commerce.market-catalog.current:v1:generation:7',
    scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: 'tenant-seller-current-markets' },
  },
  marketDefinitionRevisionRef: {
    moduleId: 'commerce.market-catalog' as const,
    resourceId: 'market-revision-7',
    resourceType: 'commerce.market-catalog.market-definition-revision' as const,
    tenantId,
  },
  observedAt: DateTime.makeUnsafe(operationAt),
  status: 'VALID' as const,
};

const supportRootRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  resourceType: 'commerce.pricing.currency-support' as const,
  tenantId,
};
const supportRevisionRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  resourceType: 'commerce.pricing.currency-support-revision' as const,
  supportRootId: supportRootRef.resourceId,
  tenantId,
};
const supportCurrent = {
  effectivePeriod: { effectiveFrom: operationAt, effectiveTo: null },
  generation: 1,
  supportedCurrencies: ['CZK'] as const,
  supportRevisionRef,
};
const defineCurrencySupport = {
  currentnessEvidence: {
    evaluatedAt: operationAt,
    evaluationMode: 'CURRENT_WITH_REVALIDATION' as const,
    observedAt: operationAt,
    revalidatedAt: operationAt,
    scheduleRevision: 1,
    supportRevisionRef,
    supportRootRef,
  },
  effectivePeriod: { effectiveFrom: operationAt, effectiveTo: null },
  generation: 1,
  observedAt: operationAt,
  pricingRevision: 'pricing-currency-support:1',
  scheduleRevision: 1,
  supportedCurrencies: ['CZK'] as const,
  supportRevisionRef,
  supportRootRef,
};
const supportResult = {
  changed: true,
  current: supportCurrent,
  scheduleRevision: 1,
  supportRootRef,
};
const supportTrusted = {
  actionInvocationId: trusted.actionInvocationId,
  actorPrincipalId: principalId,
  tenantId,
  trustedOperationAt: trusted.trustedOperationAt,
};
const establishSupport = (supportedCurrencies: readonly string[]) =>
  Schema.decodeSync(SetSupportedCurrenciesPayloadSchema)({
    expectedState: { state: 'ABSENT' },
    intendedEffectivePeriod: supportCurrent.effectivePeriod,
    intent: 'ESTABLISH_CURRENT',
    reason: 'Establish Launch Currency Support',
    schemaVersion: '2',
    supportedCurrencies,
  });
const actionPrincipal = {
  authBindingId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  authContextRef: 'session:pricing-management-797',
  authMethod: 'session' as const,
  principalId,
  tenantId,
};
const priceActionPrincipal = { ...actionPrincipal, legalEntityId };
const supportServices = (onSet?: () => void) => ({
  loadCurrent: () => Effect.die('The management Action does not use the read service'),
  setCurrent: () => {
    onSet?.();
    return Effect.succeed({ outcome: 'CREATED' as const, result: supportResult });
  },
});
const defineServices = (define: DefinePriceActionServices['define']): DefinePriceActionServices => ({
  assessCatalogSelection: () => Effect.succeed(validCatalogAssessment),
  assessCommercialContext: () => Effect.succeed(validCommercialContextAssessment),
  assessExternalPriceInput: (request) => Effect.succeed(preparePriceSourceEvidence(request)),
  define,
  loadCurrencySupport: () => Effect.succeed({ _tag: 'current', current: defineCurrencySupport }),
});

describe('Pricing management Actions acceptance', () => {
  it('publishes the exact Price and Currency generated Actions with their trusted scope rules', () => {
    expect(
      [definePriceAction, revisePriceAction, setSupportedCurrenciesAction].map(({ descriptor }) => ({
        actionKey: descriptor.actionKey,
        idempotency: descriptor.idempotency,
        legalEntityScope: descriptor.legalEntityScope,
        schemaVersion: descriptor.schemaVersion,
        scope: descriptor.entrypoint.scope,
      })),
    ).toEqual([
      {
        actionKey: 'commerce.pricing.define-price',
        idempotency: 'required',
        legalEntityScope: 'required',
        schemaVersion: '2',
        scope: 'tenant',
      },
      {
        actionKey: 'commerce.pricing.revise-price',
        idempotency: 'required',
        legalEntityScope: 'required',
        schemaVersion: '2',
        scope: 'tenant',
      },
      {
        actionKey: 'commerce.pricing.set-supported-currencies',
        idempotency: 'required',
        legalEntityScope: 'forbidden',
        schemaVersion: '2',
        scope: 'tenant',
      },
    ]);
  });

  it('requires an exact Variant and Commerce Market while excluding Product-only and Storefront Price writes', () => {
    const exact = {
      effectiveFrom: operationAt,
      identityKey,
      monetaryAmount: { amount: '100', currencyCode: 'CZK' },
      priceRef,
      reason: 'Create one exact Variant Price',
      sourceAssertion,
    };
    const decode = Schema.decodeUnknownSync(DefinePricePayloadSchema, { onExcessProperty: 'error' });

    expect(decode(exact).identityKey).toEqual(identityKey);
    expect(() =>
      decode({
        ...exact,
        identityKey: {
          ...identityKey,
          catalogSelection: { productRef },
        },
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...exact,
        identityKey: {
          ...identityKey,
          commercialScope: {
            channelId: identityKey.commercialScope.channelId,
            sellingLegalEntityId: legalEntityId,
          },
        },
      }),
    ).toThrow();
    expect(() => decode({ ...exact, storefrontId: 'storefront-cz' })).toThrow();
  });

  it.effect('checks stale expected Current state before treating a same-value edit as unchanged', () =>
    Effect.gen(function* staleBeforeNoOp() {
      const failure = yield* applyPriceRevision(
        revisePayload,
        trusted,
        reviseServices((command) => {
          expect(command).toMatchObject({
            actingPrincipalId: principalId,
            actionInvocationId: trusted.actionInvocationId,
            expectedCurrent,
            monetaryAmount: currentRevision.definition.revision.monetaryAmount,
            requestCorrelationId: trusted.requestCorrelationId,
            trustedOperationAt: trusted.trustedOperationAt,
          });
          return Effect.succeed({ outcome: 'CONFLICT' as const, reason: 'EXPECTED_CURRENT_MISMATCH' as const });
        }),
      ).pipe(Effect.flip);

      expect(failure).toBeInstanceOf(RevisePriceConflict);
      expect(failure).toMatchObject({ reason: 'EXPECTED_CURRENT_MISMATCH' });
    }),
  );

  it.effect(
    'preserves the finite Current end, schedule gap, and exact future revision in the blocking acknowledgement',
    () =>
      Effect.gen(function* preservePresentedSchedule() {
        const challenge = yield* applyPriceRevision(
          revisePayload,
          trusted,
          reviseServices(() => Effect.succeed({ acknowledgement, outcome: 'ACKNOWLEDGEMENT_REQUIRED' as const })),
        ).pipe(Effect.flip);

        expect(challenge).toBeInstanceOf(RevisePriceAcknowledgementRequired);
        expect(challenge).toMatchObject({
          acknowledgement: {
            intendedEffectivePeriod: { effectiveTo: currentPeriod.effectiveTo },
            presentedFuture: [futureRevision],
            scheduleRevision: expectedCurrent.scheduleRevision,
            targetRevisionId: expectedCurrent.revisionId,
          },
        });

        const stale = yield* applyPriceRevision(
          { ...revisePayload, acknowledgement },
          trusted,
          reviseServices((command) => {
            expect(command).toMatchObject({ acknowledgement, expectedCurrent });
            return Effect.succeed({ outcome: 'CONFLICT' as const, reason: 'SCHEDULE_ACKNOWLEDGEMENT_STALE' as const });
          }),
        ).pipe(Effect.flip);
        expect(stale).toBeInstanceOf(RevisePriceConflict);
        expect(stale).toMatchObject({ reason: 'SCHEDULE_ACKNOWLEDGEMENT_STALE' });
      }),
  );

  it.effect('publishes the exact schedule gap and future evidence needed to construct an acknowledgement', () =>
    Effect.gen(function* publicScheduleRead() {
      const schedule = {
        outcome: 'PRICE_SCHEDULE_GAP' as const,
        schedule: {
          future: [futureRevision],
          observedAt: '2026-10-15T00:00:00.000Z',
          priceRef,
          revisions: [currentRevision, futureRevision],
          scheduleRevision: expectedCurrent.scheduleRevision,
        },
      };
      const requests: Request[] = [];
      const fakeFetch: typeof globalThis.fetch = (input, init) => {
        requests.push(new Request(input, init));
        return Promise.resolve(Response.json(schedule, { status: 200 }));
      };
      const response = yield* executePriceScheduleWithAuthorization(
        { priceRef },
        'Bearer owner-assertion',
        'price-schedule-797',
        { baseUrl: 'https://pricing.example/pricing-api' },
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
      const [request] = requests;
      if (request === undefined) {
        throw new Error('The Price Schedule client did not issue its governed request');
      }

      expect(response).toEqual(schedule);
      expect(requests).toHaveLength(1);
      expect(request.url).toBe('https://pricing.example/pricing-api/reads/price-schedule');
      expect(yield* Effect.promise(() => request.clone().json())).toEqual({ priceRef });
    }),
  );

  it('keeps the exact schedule acknowledgement in the public blocking warning', () => {
    const problem = mapRevisePriceActionProblem(
      new RevisePriceAcknowledgementRequired({
        acknowledgement,
        code: 'price_schedule_acknowledgement_required',
        reason: 'The exact future schedule requires acknowledgement',
      }),
    );

    expect(problem).toMatchObject({
      acknowledgement,
      code: 'price_schedule_acknowledgement_required',
      status: 422,
    });
  });

  it.effect('keeps Currency Support Tenant-only and accepts only the Launch set {CZK}', () =>
    Effect.gen(function* tenantCurrencySupport() {
      const commands: unknown[] = [];
      const accepted = yield* applySupportedCurrencies(establishSupport(['CZK']), supportTrusted, (command) => {
        commands.push(command);
        return Effect.succeed({ outcome: 'CREATED' as const, result: supportResult });
      });
      const rejected = yield* applySupportedCurrencies(establishSupport(['EUR']), supportTrusted, () =>
        Effect.die('EUR must not reach persistence'),
      ).pipe(Effect.flip);

      expect(accepted).toEqual(supportResult);
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({ supportedCurrencies: ['CZK'], tenantId });
      expect(yield* encodeJson(commands[0])).not.toMatch(/cart|channel|market|storefront|subject|legalEntity/iu);
      expect(rejected).toBeInstanceOf(SupportedCurrenciesAdministrationRejected);
      expect(rejected).toMatchObject({ code: 'supported_currencies_launch_set_invalid' });
    }),
  );

  it.effect('preserves fresh trusted operation time when the same Currency Support invocation is retried', () =>
    Effect.gen(function* freshRetryTime() {
      const commands: SetCurrencySupportCommand[] = [];
      const payload = establishSupport(['CZK']);
      const laterTrusted = {
        ...supportTrusted,
        trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-09-27T12:05:00.000Z')),
      };
      const persist = (command: (typeof commands)[number]) => {
        commands.push(command);
        return Effect.succeed({ outcome: 'CREATED' as const, result: supportResult });
      };

      const first = yield* applySupportedCurrencies(payload, supportTrusted, persist);
      const replay = yield* applySupportedCurrencies(payload, laterTrusted, persist);

      expect(first).toEqual(supportResult);
      expect(replay).toEqual(supportResult);
      expect(commands).toHaveLength(2);
      expect(commands[0]).toMatchObject({
        actingPrincipalId: supportTrusted.actorPrincipalId,
        actionInvocationId: supportTrusted.actionInvocationId,
        trustedOperationAt: supportTrusted.trustedOperationAt,
      });
      expect(commands[1]).toMatchObject({
        actingPrincipalId: supportTrusted.actorPrincipalId,
        actionInvocationId: supportTrusted.actionInvocationId,
        trustedOperationAt: laterTrusted.trustedOperationAt,
      });
    }),
  );

  it.effect('serializes a concurrent first create to one generated Action execution', () =>
    Effect.gen(function* serializeFirstCreate() {
      let writes = 0;
      const harness = yield* makeActionTestHarness({
        actionPermission: 'allowed',
        services: [
          bindActionTestServices(
            setSupportedCurrenciesAction,
            supportServices(() => {
              writes += 1;
            }),
          ),
        ],
      });
      const request = {
        payload: establishSupport(['CZK']),
        principal: actionPrincipal,
        registration: setSupportedCurrenciesAction,
        transport: { correlationId: 'currency-support-first-create', idempotencyKey: 'currency-support:create' },
      } as const;
      const outcomes = yield* Effect.forEach(
        [harness.runtime.runAction(request), harness.runtime.runAction(request)],
        (operation) =>
          operation.pipe(
            Effect.match({
              onFailure: (failure) =>
                Predicate.isTagged(failure, 'ActionAlreadyCommitted') ? 'already_committed' : 'unexpected_failure',
              onSuccess: () => 'business_result',
            }),
          ),
        { concurrency: 'unbounded' },
      );

      expect(outcomes).toContain('business_result');
      expect(outcomes).toContain('already_committed');
      expect(writes).toBe(1);
      expect(harness.snapshot().committed).toHaveLength(1);
      expect(harness.snapshot().transactionCount).toBe(1);
    }),
  );

  it.effect('resolves a lost first-create response by the original invocation without rerunning the write', () =>
    Effect.gen(function* resolveLostResponse() {
      let writes = 0;
      const harness = yield* makeActionTestHarness({
        actionPermission: 'allowed',
        commitAcknowledgement: 'indeterminate-once',
        services: [
          bindActionTestServices(
            setSupportedCurrenciesAction,
            supportServices(() => {
              writes += 1;
            }),
          ),
        ],
      });
      const failure = yield* harness.runtime
        .runAction({
          payload: establishSupport(['CZK']),
          principal: actionPrincipal,
          registration: setSupportedCurrenciesAction,
          transport: { correlationId: 'currency-support-lost-response', idempotencyKey: 'currency-support:lost' },
        })
        .pipe(Effect.flip);

      expect(Predicate.isTagged(failure, 'ActionCommitIndeterminate')).toBe(true);
      if (!Predicate.isTagged(failure, 'ActionCommitIndeterminate')) {
        throw new Error('Expected the first create commit to be indeterminate');
      }
      const resolution = yield* harness.runtime
        .resolveActionCommit({ invocationId: failure.invocationId, principal: actionPrincipal })
        .pipe(Effect.flip);

      expect(Predicate.isTagged(resolution, 'ActionAlreadyCommitted')).toBe(true);
      expect(writes).toBe(1);
      expect(harness.snapshot().committed).toHaveLength(1);
    }),
  );

  it.effect('reconciles indeterminate Define and Revise writes before permitting any retry', () =>
    Effect.gen(function* reconcilePriceUnknownWrites() {
      let defineOwnerResult: DefinePricePersistenceOutcome | undefined;
      let defineWrites = 0;
      const defineHarness = yield* makeActionTestHarness({
        actionPermission: 'allowed',
        commitAcknowledgement: 'indeterminate-once',
        services: [
          bindActionTestServices(
            definePriceAction,
            defineServices((command) => {
              defineWrites += 1;
              const definition = {
                identityKey: command.identityKey,
                priceRef: command.priceRef,
                revision: {
                  effectiveFrom: command.effectiveFrom,
                  monetaryAmount: command.monetaryAmount,
                  monetaryBoundary: 'PRE_TAX' as const,
                  revision: 1,
                  revisionId: 'adadadad-adad-4dad-8dad-adadadadadad',
                },
              };
              const provenance = Schema.decodeSync(PriceSourceProvenanceSchema)({
                canonicalLink: {
                  effectiveFrom: definition.revision.effectiveFrom,
                  identityKey: definition.identityKey,
                  monetaryAmount: definition.revision.monetaryAmount,
                  monetaryBoundary: definition.revision.monetaryBoundary,
                  priceRef: definition.priceRef,
                  revision: definition.revision.revision,
                  revisionId: definition.revision.revisionId,
                },
                evidence: command.sourceEvidence,
                provenanceRef: 'aeaeaeae-aeae-4eae-8eae-aeaeaeaeaeae',
              });
              defineOwnerResult = { definition, outcome: 'CREATED', provenance };
              return Effect.succeed(defineOwnerResult);
            }),
          ),
        ],
      });
      const defineRequest = {
        payload: definePayload,
        principal: priceActionPrincipal,
        registration: definePriceAction,
        transport: { correlationId: 'define-price-lost-response', idempotencyKey: 'define-price:lost' },
      } as const;
      const defineFailure = yield* defineHarness.runtime.runAction(defineRequest).pipe(Effect.flip);
      expect(Predicate.isTagged(defineFailure, 'ActionCommitIndeterminate')).toBe(true);
      if (!Predicate.isTagged(defineFailure, 'ActionCommitIndeterminate')) {
        throw new Error('Expected Define Price commit acknowledgement to be indeterminate');
      }
      expect(mapDefinePriceActionProblem(defineFailure)).toMatchObject({
        invocationId: defineFailure.invocationId,
        resolution: 'RESOLVE_COMMIT',
        retryCommand: false,
        status: 503,
      });
      const defineLookup = yield* readPriceResult(
        yield* Schema.decodeEffect(PriceResultLookupRequestSchema)({
          actionInvocationId: defineFailure.invocationId,
        }),
        { legalEntityId },
        {
          lookupResult: ({ actionInvocationId }) => {
            if (defineOwnerResult === undefined) {
              return Effect.die('Define Price owner result was not captured');
            }
            return Effect.succeed({
              actionInvocationId,
              outcome: 'PRICE_ACTION_RESULT_FOUND' as const,
              result: defineOwnerResult,
            });
          },
          resolveCommit: () =>
            defineHarness.runtime
              .resolveActionCommit({ invocationId: defineFailure.invocationId, principal: priceActionPrincipal })
              .pipe(
                Effect.match({
                  onFailure: (failure) =>
                    Predicate.isTagged(failure, 'ActionAlreadyCommitted')
                      ? ('COMMITTED' as const)
                      : ('UNAVAILABLE' as const),
                  onSuccess: () => 'OPEN' as const,
                }),
              ),
        },
      );
      expect(defineLookup).toMatchObject({
        actionInvocationId: defineFailure.invocationId,
        outcome: 'PRICE_ACTION_RESULT_FOUND',
        result: { outcome: 'CREATED' },
      });
      expect(defineWrites).toBe(1);
      expect(defineHarness.snapshot().committed).toHaveLength(1);

      let reviseOwnerResult: RevisePricePersistenceOutcome | undefined;
      let reviseWrites = 0;
      const reviseHarness = yield* makeActionTestHarness({
        actionPermission: 'allowed',
        commitAcknowledgement: 'indeterminate-once',
        services: [
          bindActionTestServices(revisePriceAction, {
            ...reviseServices((command) => {
              if (!('sourceEvidence' in command)) {
                return Effect.die('Value-only revision must carry source evidence');
              }
              reviseWrites += 1;
              const provenance = Schema.decodeSync(PriceSourceProvenanceSchema)({
                canonicalLink: {
                  effectiveFrom: revisedRevision.definition.revision.effectiveFrom,
                  identityKey: revisedRevision.definition.identityKey,
                  monetaryAmount: revisedRevision.definition.revision.monetaryAmount,
                  monetaryBoundary: revisedRevision.definition.revision.monetaryBoundary,
                  priceRef: revisedRevision.definition.priceRef,
                  revision: revisedRevision.definition.revision.revision,
                  revisionId: revisedRevision.definition.revision.revisionId,
                },
                evidence: command.sourceEvidence,
                provenanceRef: 'afafafaf-afaf-4faf-8faf-afafafafafaf',
              });
              reviseOwnerResult = { outcome: 'REVISED', provenance, revision: revisedRevision };
              return Effect.succeed(reviseOwnerResult);
            }),
            assessExternalPriceInput: (request) =>
              Effect.succeed(
                preparePriceSourceEvidence({
                  actingPrincipalId: request.actingPrincipalId,
                  identityKey: request.identityKey,
                  monetaryAmount: request.monetaryAmount,
                  sourceAssertion: request.sourceAssertion,
                  tenantId: request.tenantId,
                  trustedOperationAt: request.trustedOperationAt,
                }),
              ),
          }),
        ],
      });
      const reviseRequest = {
        payload: revisePayload,
        principal: priceActionPrincipal,
        registration: revisePriceAction,
        transport: { correlationId: 'revise-price-lost-response', idempotencyKey: 'revise-price:lost' },
      } as const;
      const reviseFailure = yield* reviseHarness.runtime.runAction(reviseRequest).pipe(Effect.flip);
      expect(Predicate.isTagged(reviseFailure, 'ActionCommitIndeterminate')).toBe(true);
      if (!Predicate.isTagged(reviseFailure, 'ActionCommitIndeterminate')) {
        throw new Error('Expected Revise Price commit acknowledgement to be indeterminate');
      }
      expect(mapRevisePriceActionProblem(reviseFailure)).toMatchObject({
        invocationId: reviseFailure.invocationId,
        resolution: 'RESOLVE_COMMIT',
        retryCommand: false,
        status: 503,
      });
      const reviseLookup = yield* readPriceResult(
        yield* Schema.decodeEffect(PriceResultLookupRequestSchema)({
          actionInvocationId: reviseFailure.invocationId,
        }),
        { legalEntityId },
        {
          lookupResult: ({ actionInvocationId }) => {
            if (reviseOwnerResult === undefined) {
              return Effect.die('Revise Price owner result was not captured');
            }
            return Effect.succeed({
              actionInvocationId,
              outcome: 'PRICE_ACTION_RESULT_FOUND' as const,
              result: reviseOwnerResult,
            });
          },
          resolveCommit: () =>
            reviseHarness.runtime
              .resolveActionCommit({ invocationId: reviseFailure.invocationId, principal: priceActionPrincipal })
              .pipe(
                Effect.match({
                  onFailure: (failure) =>
                    Predicate.isTagged(failure, 'ActionAlreadyCommitted')
                      ? ('COMMITTED' as const)
                      : ('UNAVAILABLE' as const),
                  onSuccess: () => 'OPEN' as const,
                }),
              ),
        },
      );
      expect(reviseLookup).toMatchObject({
        actionInvocationId: reviseFailure.invocationId,
        outcome: 'PRICE_ACTION_RESULT_FOUND',
        result: { outcome: 'REVISED' },
      });
      expect(reviseWrites).toBe(1);
      expect(reviseHarness.snapshot().committed).toHaveLength(1);

      for (const actionKind of ['DEFINE_PRICE', 'REVISE_PRICE'] as const) {
        for (const resolution of ['ABSENT', 'OPEN'] as const) {
          const retryDecision = yield* readPriceResult(
            yield* Schema.decodeEffect(PriceResultLookupRequestSchema)({
              actionInvocationId: trusted.actionInvocationId,
            }),
            { legalEntityId },
            {
              lookupResult: ({ actionInvocationId }) =>
                Effect.succeed({ actionInvocationId, outcome: 'PRICE_ACTION_RESULT_ABSENT' as const }),
              resolveCommit: () => Effect.succeed(resolution),
            },
          );
          expect(retryDecision, `${actionKind} may retry only after Core and owner absence`).toEqual({
            actionInvocationId: trusted.actionInvocationId,
            outcome: 'PRICE_ACTION_RESULT_ABSENT',
          });
        }
      }
    }).pipe(Effect.provideService(ExternalPriceInputBoundaryFactory, { make: makeExternalPriceInputBoundary })),
  );

  it('directs committed retries to governed reads and uncertain commits to result lookup without retrying the command', () => {
    expect(
      mapDefinePriceActionProblem(
        new ActionAlreadyCommitted({
          code: 'action_already_committed',
          invocationId: trusted.actionInvocationId,
          reason: 'The exact intent is already committed',
        }),
      ),
    ).toMatchObject({
      invocationId: trusted.actionInvocationId,
      resolution: 'REFRESH_GOVERNED_READS',
      retryCommand: false,
      status: 409,
    });
    expect(
      mapDefinePriceActionProblem(
        new ActionCommitIndeterminate({
          code: 'action_commit_indeterminate',
          invocationId: trusted.actionInvocationId,
          reason: 'Commit acknowledgement was lost',
        }),
      ),
    ).toMatchObject({
      invocationId: trusted.actionInvocationId,
      resolution: 'RESOLVE_COMMIT',
      retryCommand: false,
      status: 503,
    });
  });
});
