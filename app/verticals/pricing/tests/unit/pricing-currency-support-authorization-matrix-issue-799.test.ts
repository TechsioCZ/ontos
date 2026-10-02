import { ActionPermissionDenied, ReadPermissionDenied } from '@app/core-runtime';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { CurrentSupportedCurrenciesRequestSchema } from '@app/pricing-contracts/current-supported-currencies';
import { DateTime, Effect, Predicate, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  DefinePricePayloadSchema,
  DefinePriceRejected,
  applyPriceDefinition,
  definePriceAction,
} from '../../src/actions/define-price.action.ts';
import {
  SetSupportedCurrenciesPayloadSchema,
  SupportedCurrenciesAdministrationRejected,
  applySupportedCurrencies,
  setSupportedCurrenciesAction,
} from '../../src/actions/set-supported-currencies.action.ts';
import {
  currentSupportedCurrenciesRead,
  resolveCurrentSupportedCurrencies,
} from '../../src/api/current-supported-currencies.read.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const foreignTenantId = '22222222-2222-4222-8222-222222222222';
const legalEntityId = '33333333-3333-4333-8333-333333333333';
const foreignLegalEntityId = '44444444-4444-4444-8444-444444444444';
const principalId = '55555555-5555-4555-8555-555555555555';
const effectiveAt = '2026-09-27T12:00:00.000Z';
const trustedOperationAt = DateTime.toDateUtc(DateTime.makeUnsafe(effectiveAt));
const supportRootRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: '66666666-6666-4666-8666-666666666666',
  resourceType: 'commerce.pricing.currency-support' as const,
  tenantId,
};
const supportRevisionRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: '77777777-7777-4777-8777-777777777777',
  resourceType: 'commerce.pricing.currency-support-revision' as const,
  supportRootId: supportRootRef.resourceId,
  tenantId,
};
const supportResult = {
  changed: true,
  current: {
    effectivePeriod: { effectiveFrom: effectiveAt, effectiveTo: null },
    generation: 1,
    supportedCurrencies: ['CZK'] as const,
    supportRevisionRef,
  },
  scheduleRevision: 1,
  supportRootRef,
};
const supportTrusted = {
  actionInvocationId: '88888888-8888-4888-8888-888888888888',
  actorPrincipalId: principalId,
  tenantId,
  trustedOperationAt,
};
const actionPrincipal = {
  authBindingId: '99999999-9999-4999-8999-999999999999',
  authContextRef: 'better-auth-session:pricing-currency-support-operator',
  authMethod: 'session' as const,
  principalId,
  tenantId,
};

const decodeSupport = Schema.decodeUnknownSync(SetSupportedCurrenciesPayloadSchema);
const establishSupport = (supportedCurrencies: readonly string[]) =>
  decodeSupport({
    expectedState: { state: 'ABSENT' },
    intendedEffectivePeriod: supportResult.current.effectivePeriod,
    intent: 'ESTABLISH_CURRENT',
    reason: 'Establish the exact Launch Currency Support set',
    schemaVersion: '2',
    supportedCurrencies,
  });
const supportServices = (onSet: () => void) => ({
  loadCurrent: () => Effect.die('The Currency Support Action must not call its read service'),
  setCurrent: () => {
    onSet();
    return Effect.succeed({ outcome: 'CREATED' as const, result: supportResult });
  },
});

const priceRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  resourceType: 'commerce.pricing.price' as const,
  tenantId,
};
const productRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  resourceType: 'commerce.catalog.product' as const,
  tenantId,
};
const variantRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  resourceType: 'commerce.catalog.variant' as const,
  tenantId,
};
const unitBasis = {
  quantity: '1',
  unitRef: {
    moduleId: 'commerce.catalog' as const,
    resourceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    resourceType: 'commerce.catalog.product-unit' as const,
    tenantId,
  },
};
const pricePayload = Schema.decodeSync(DefinePricePayloadSchema)({
  effectiveFrom: effectiveAt,
  identityKey: {
    catalogSelection: { productRef, variantRef },
    commercialScope: { channelId: 'B2C', marketId: 'cz-launch', sellingLegalEntityId: legalEntityId },
    currencyCode: 'CZK',
    priceGroupSelector: { kind: 'NO_GROUP' },
    unitBasis,
  },
  monetaryAmount: { amount: '100', currencyCode: 'CZK' },
  priceRef,
  reason: 'Define the exact CZK Launch Price',
  sourceAssertion: {
    lineage: { kind: 'INITIAL' },
    mapping: { mappingContractRef: 'erp-price-v2', mappingContractVersion: '2' },
    originalAssertion: {
      monetaryAmount: { amount: '100', currencyCode: 'CZK' },
      monetaryBoundary: 'PRE_TAX',
      unitBasis,
    },
    sourceAssertionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    sourceAuthority: { sourceAuthorityRef: 'pricing-owner', sourceAuthorityVersion: '7' },
    sourceRecord: {
      sourceChangeCorrelation: 'change-799',
      sourceRecordRef: 'price-row-799',
      sourceRecordVersion: '1',
      sourceSystem: { ownerModuleId: 'commerce.pricing', sourceSystemRef: 'erp-eu' },
    },
    timing: {
      importedAt: '2026-09-27T12:00:00.500Z',
      ownerBusinessEffectiveAt: effectiveAt,
      sourceEffectiveAt: '2026-09-27T11:59:00.000Z',
    },
  },
});

describe('Pricing Currency Support authorization matrix (#799)', () => {
  it('keeps Currency Support Tenant-scoped while Price writes remain Selling-Legal-Entity-scoped', () => {
    expect(currentSupportedCurrenciesRead.descriptor.entrypoint.authorization).toEqual({
      kind: 'context_permission',
      permission: 'pricing.currency_support.read',
    });
    expect(currentSupportedCurrenciesRead.descriptor.legalEntityScope).toBe('forbidden');
    expect(setSupportedCurrenciesAction.descriptor.entrypoint.authorization).toEqual({
      kind: 'action_execution',
      provisioning: 'explicit',
    });
    expect(setSupportedCurrenciesAction.descriptor.legalEntityScope).toBe('forbidden');
    expect(definePriceAction.descriptor.legalEntityScope).toBe('required');
  });

  it.effect('denies cross-Tenant read and write before owner persistence can observe them', () =>
    Effect.gen(function* crossTenantIsolation() {
      const request = yield* Schema.decodeEffect(CurrentSupportedCurrenciesRequestSchema)({ effectiveAt, tenantId });
      let reads = 0;
      const readFailure = yield* resolveCurrentSupportedCurrencies(request, { tenantId: foreignTenantId }, () => {
        reads += 1;
        return Effect.die('A foreign Currency Support read must not reach the owner service');
      }).pipe(Effect.flip);
      expect(readFailure).toBeInstanceOf(ReadPermissionDenied);
      expect(reads).toBe(0);

      const foreignExpectedState = decodeSupport({
        expectedState: {
          current: {
            ...supportResult.current,
            supportRevisionRef: { ...supportRevisionRef, tenantId: foreignTenantId },
          },
          future: [],
          observedAt: effectiveAt,
          scheduleRevision: 1,
          state: 'PRESENT',
          supportRootRef: { ...supportRootRef, tenantId: foreignTenantId },
        },
        intendedEffectivePeriod: supportResult.current.effectivePeriod,
        intent: 'VALUE_ONLY_CURRENT',
        reason: 'Attempt to mutate another Tenant Currency Support root',
        schemaVersion: '2',
        supportedCurrencies: ['CZK'],
      });
      let writes = 0;
      const writeFailure = yield* applySupportedCurrencies(foreignExpectedState, supportTrusted, () => {
        writes += 1;
        return Effect.die('A foreign Currency Support write must not reach persistence');
      }).pipe(Effect.flip);
      expect(writeFailure).toMatchObject({ code: 'supported_currencies_scope_mismatch' });
      expect(writes).toBe(0);
    }),
  );

  it.effect('does not infer Currency Support mutation authority from membership, Buyer, or Approver identity', () =>
    Effect.gen(function* unrelatedAuthorityDenied() {
      for (const authority of ['TENANT_MEMBERSHIP', 'BUYER', 'APPROVER'] as const) {
        let ownerCalls = 0;
        const harness = yield* makeActionTestHarness({
          actionPermission: 'denied',
          services: [
            bindActionTestServices(
              setSupportedCurrenciesAction,
              supportServices(() => {
                ownerCalls += 1;
              }),
            ),
          ],
        });
        const failure = yield* harness.runtime
          .runAction({
            payload: establishSupport(['CZK']),
            principal: { ...actionPrincipal, authContextRef: `better-auth-session:${authority.toLowerCase()}` },
            registration: setSupportedCurrenciesAction,
            transport: {
              correlationId: `currency-support-${authority.toLowerCase()}-denied`,
              idempotencyKey: `currency-support-${authority.toLowerCase()}-denied`,
            },
          })
          .pipe(Effect.flip);

        expect(failure).toBeInstanceOf(ActionPermissionDenied);
        expect(ownerCalls).toBe(0);
        expect(harness.snapshot().permissionDenials).toHaveLength(1);
        expect(harness.snapshot().stages).not.toContain('handler_executed');
      }
    }),
  );

  it.effect('allows the explicitly governed operator and still rejects non-CZK Launch activation', () =>
    Effect.gen(function* exactOperatorAuthority() {
      let acceptedWrites = 0;
      const allowed = yield* makeActionTestHarness({
        actionPermission: 'allowed',
        services: [
          bindActionTestServices(
            setSupportedCurrenciesAction,
            supportServices(() => {
              acceptedWrites += 1;
            }),
          ),
        ],
      });
      const accepted = yield* allowed.runtime.runAction({
        payload: establishSupport(['CZK']),
        principal: actionPrincipal,
        registration: setSupportedCurrenciesAction,
        transport: { correlationId: 'currency-support-operator', idempotencyKey: 'currency-support-operator' },
      });
      expect(accepted).toEqual(supportResult);
      expect(acceptedWrites).toBe(1);
      expect(allowed.snapshot().committed).toHaveLength(1);

      let rejectedWrites = 0;
      const launchGate = yield* makeActionTestHarness({
        actionPermission: 'allowed',
        services: [
          bindActionTestServices(
            setSupportedCurrenciesAction,
            supportServices(() => {
              rejectedWrites += 1;
            }),
          ),
        ],
      });
      const rejected = yield* launchGate.runtime
        .runAction({
          payload: establishSupport(['EUR']),
          principal: actionPrincipal,
          registration: setSupportedCurrenciesAction,
          transport: { correlationId: 'currency-support-eur', idempotencyKey: 'currency-support-eur' },
        })
        .pipe(Effect.flip);
      expect(rejected).toBeInstanceOf(SupportedCurrenciesAdministrationRejected);
      expect(rejected).toMatchObject({ code: 'supported_currencies_launch_set_invalid' });
      expect(rejectedWrites).toBe(0);
      expect(launchGate.snapshot().committed).toHaveLength(0);
    }),
  );

  it.effect('rejects a Price write for another Selling Legal Entity before any owner dependency runs', () =>
    Effect.gen(function* sellingLegalEntityIsolation() {
      let ownerCalls = 0;
      const unexpectedOwnerCall = () => {
        ownerCalls += 1;
        return Effect.die('A cross-Selling-Legal-Entity Price write must not reach an owner dependency');
      };
      const failure = yield* applyPriceDefinition(
        pricePayload,
        {
          actingPrincipalId: principalId,
          actionInvocationId: supportTrusted.actionInvocationId,
          legalEntityId: foreignLegalEntityId,
          requestCorrelationId: 'price-cross-sle',
          tenantId,
          trustedOperationAt,
        },
        {
          assessCatalogSelection: unexpectedOwnerCall,
          assessCommercialContext: unexpectedOwnerCall,
          assessExternalPriceInput: unexpectedOwnerCall,
          define: unexpectedOwnerCall,
          loadCurrencySupport: unexpectedOwnerCall,
        },
      ).pipe(Effect.flip);

      expect(Predicate.isTagged(failure, 'DefinePriceRejected')).toBe(true);
      expect(failure).toBeInstanceOf(DefinePriceRejected);
      expect(failure).toMatchObject({ code: 'define_price_scope_mismatch' });
      expect(ownerCalls).toBe(0);
    }),
  );
});
