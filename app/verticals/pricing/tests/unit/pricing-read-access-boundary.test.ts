import type { ContextAccessService, OperationalScope } from '@app/core-runtime';
import { ReadPermissionDenied, toContextPermissionAccessKey } from '@app/core-runtime';
import { CurrentSupportedCurrenciesRequestSchema } from '@app/pricing-contracts/current-supported-currencies';
import { PricingExplicitInputContextSchema } from '@app/pricing-contracts/domain/broken-explicit-input';
import { DateTime, Effect, Predicate, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { makeReadRuntime } from '../../../../packages/core-runtime/src/reads/runtime.ts';
import { makeTestDatabase } from '../../../../packages/core-runtime/tests/support/database.ts';
import { openModuleEntrypointGateway } from '../../../../packages/core-runtime/tests/support/open-module-entrypoint-gateway.ts';
import { pricingCommercialFeeReadPermission } from '../../shared/permissions/pricing-commercial-fee-read.ts';
import { pricingCurrencySupportReadPermission } from '../../shared/permissions/pricing-currency-support-read.ts';
import { pricingExactPriceResolutionReadPermission } from '../../shared/permissions/pricing-exact-price-resolution-read.ts';
import { pricingPriceReadPermission } from '../../shared/permissions/pricing-price-read.ts';
import { setSupportedCurrenciesAction } from '../../src/actions/set-supported-currencies.action.ts';
import { commercialFeeDefinitionRead } from '../../src/api/commercial-fee-definition.read.ts';
import { commercialFeeScheduleRead } from '../../src/api/commercial-fee-schedule.read.ts';
import { currentSupportedCurrenciesRead } from '../../src/api/current-supported-currencies.read.ts';
import { exactPriceResolutionRead } from '../../src/api/exact-price-resolution.read.ts';
import { priceDefinitionRead } from '../../src/api/price-definition.read.ts';
import { priceScheduleRead } from '../../src/api/price-schedule.read.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const foreignTenantId = '10000000-0000-4000-8000-000000000002';
const principalId = '30000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const effectiveAt = '2026-09-22T12:00:00.000Z';
const observedAt = '2026-09-22T12:00:02.000Z';
const scope: OperationalScope = {
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'session:pricing-read-access-boundary',
  authMethod: 'session',
  correlationId: 'pricing-read-access-boundary',
  principalId,
  tenantId,
};
const principal = {
  authBindingId: scope.authBindingId,
  authContextRef: scope.authContextRef,
  authMethod: scope.authMethod,
  principalId,
  tenantId,
} as const;
const request = Schema.decodeSync(CurrentSupportedCurrenciesRequestSchema)({ effectiveAt, tenantId });
const exactPriceRequest = Schema.decodeSync(PricingExplicitInputContextSchema)({
  effectiveAt,
  requestedCurrencyCode: 'CZK',
  tenantId,
});

interface HarnessOptions {
  readonly operationalScope?: OperationalScope;
  readonly permissionDecision: 'allowed' | 'denied';
}

const makeHarness = Effect.fn(function* makePricingReadAccessHarness(options: HarnessOptions) {
  const contextPermissions: string[] = [];
  const routineCalls: string[] = [];
  const stages: string[] = [];
  const operationalScope = options.operationalScope ?? scope;
  const database = {
    executor: yield* makeTestDatabase((text) => {
      if (text.includes('transaction_timestamp')) {
        return Effect.succeed([{ operation_at: DateTime.toDateUtc(DateTime.makeUnsafe(observedAt)) }]);
      }
      if (text.includes('data_access_events')) {
        return Effect.succeed([]);
      }
      if (text.includes('current_setting')) {
        return Effect.succeed([
          { legal_entity_id: operationalScope.legalEntityId ?? '', tenant_id: operationalScope.tenantId },
        ]);
      }
      if (text.includes('read_tenant_currency_support_v1')) {
        routineCalls.push('read_tenant_currency_support_v1');
        return Effect.succeed([
          {
            payload: {
              activeRevisionCount: 0,
              evaluatedAt: effectiveAt,
              evaluationMode: 'HISTORICAL_AS_OF',
              observedAt,
              outcome: 'CURRENCY_SUPPORT_ABSENT',
            },
          },
        ]);
      }
      if (text.includes('revalidate_tenant_currency_support_v1')) {
        routineCalls.push('revalidate_tenant_currency_support_v1');
        return Effect.succeed([
          {
            payload: {
              activeRevisionCount: 0,
              evaluatedAt: observedAt,
              evaluationMode: 'CURRENT_WITH_REVALIDATION',
              observedAt,
              outcome: 'CURRENCY_SUPPORT_ABSENT',
              revalidatedAt: observedAt,
            },
          },
        ]);
      }
      return Effect.succeed([]);
    }),
  };
  const contextAccess: ContextAccessService = {
    businessPermissions: () => Effect.die('Currency Support reads must not use business-target permissions'),
    contextPermissions: ({ targets }) =>
      Effect.succeed(
        targets.map((target) => {
          contextPermissions.push(target.permission);
          return { decision: options.permissionDecision, key: toContextPermissionAccessKey(target) };
        }),
      ),
    legalEntities: ({ legalEntityIds }) =>
      Effect.succeed(legalEntityIds.map((key) => ({ decision: 'allowed' as const, key }))),
    modules: ({ moduleIds }) => Effect.succeed(moduleIds.map((key) => ({ decision: 'allowed' as const, key }))),
    resources: ({ resources }) =>
      Effect.succeed(
        resources.map((resource) => ({
          decision: 'denied' as const,
          key: `${resource.moduleId}:${resource.resourceType}:${resource.resourceId}`,
        })),
      ),
    tenants: ({ tenantIds }) => Effect.succeed(tenantIds.map((key) => ({ decision: 'allowed' as const, key }))),
  };
  const runtime = makeReadRuntime(
    database,
    openModuleEntrypointGateway,
    { resolve: () => Effect.succeed(operationalScope) },
    contextAccess,
    {
      onStage: (stage) => {
        stages.push(stage);
      },
    },
  );
  return { contextPermissions, routineCalls, runtime, stages };
});

describe('Pricing read access boundary', () => {
  it('publishes generated module-scoped read permissions while the Currency Support write stays explicit', () => {
    expect(pricingCommercialFeeReadPermission).toMatchObject({
      allowedScopeKinds: ['module'],
      customerDelegable: false,
      key: 'pricing.commercial_fee.read',
      owningCapability: 'commerce.pricing',
      protectedEntrypoints: [
        'commerce.pricing.api.commercial-fee-definition',
        'commerce.pricing.api.commercial-fee-schedule',
      ],
    });
    expect(pricingCurrencySupportReadPermission).toMatchObject({
      allowedScopeKinds: ['module'],
      customerDelegable: false,
      key: 'pricing.currency_support.read',
      owningCapability: 'commerce.pricing',
      protectedEntrypoints: ['commerce.pricing.api.current-supported-currencies'],
    });
    expect(pricingExactPriceResolutionReadPermission).toMatchObject({
      allowedScopeKinds: ['module'],
      customerDelegable: false,
      key: 'pricing.exact_price_resolution.read',
      owningCapability: 'commerce.pricing',
      protectedEntrypoints: ['commerce.pricing.api.exact-price-resolution'],
    });
    expect(pricingPriceReadPermission).toMatchObject({
      allowedScopeKinds: ['module'],
      customerDelegable: false,
      key: 'pricing.price.read',
      owningCapability: 'commerce.pricing',
      protectedEntrypoints: ['commerce.pricing.api.price-definition', 'commerce.pricing.api.price-schedule'],
    });
    expect(
      [
        commercialFeeDefinitionRead,
        commercialFeeScheduleRead,
        currentSupportedCurrenciesRead,
        exactPriceResolutionRead,
        priceDefinitionRead,
        priceScheduleRead,
      ].map(({ descriptor }) => descriptor.entrypoint.authorization),
    ).toEqual([
      { kind: 'context_permission', permission: 'pricing.commercial_fee.read' },
      { kind: 'context_permission', permission: 'pricing.commercial_fee.read' },
      { kind: 'context_permission', permission: 'pricing.currency_support.read' },
      { kind: 'context_permission', permission: 'pricing.exact_price_resolution.read' },
      { kind: 'context_permission', permission: 'pricing.price.read' },
      { kind: 'context_permission', permission: 'pricing.price.read' },
    ]);
    expect(setSupportedCurrenciesAction.descriptor.entrypoint.authorization).toEqual({
      kind: 'action_execution',
      provisioning: 'explicit',
    });
  });

  it.effect(
    'requires the exact Currency Support permission before the owner routine and keeps Tenant scope exact',
    () =>
      Effect.gen(function* currentSupportedCurrenciesPermission() {
        const denied = yield* makeHarness({ permissionDecision: 'denied' });
        const denial = yield* denied.runtime
          .runRead({
            input: request,
            principal,
            registration: currentSupportedCurrenciesRead,
            transport: { correlationId: scope.correlationId },
          })
          .pipe(Effect.flip);

        expect(Schema.is(ReadPermissionDenied)(denial)).toBe(true);
        expect(denied.contextPermissions).toEqual(['pricing.currency_support.read']);
        expect(denied.routineCalls).toEqual([]);

        const allowed = yield* makeHarness({ permissionDecision: 'allowed' });
        const result = yield* allowed.runtime.runRead({
          input: request,
          principal,
          registration: currentSupportedCurrenciesRead,
          transport: { correlationId: scope.correlationId },
        });

        expect(result).toMatchObject({
          code: 'pricing_currency_support_not_initialized',
          outcome: 'SUPPORTED_CURRENCIES_UNAVAILABLE',
        });
        expect(allowed.contextPermissions).toEqual(['pricing.currency_support.read']);
        expect(allowed.routineCalls).toEqual([
          'read_tenant_currency_support_v1',
          'revalidate_tenant_currency_support_v1',
        ]);

        const crossTenant = yield* makeHarness({ permissionDecision: 'allowed' });
        const crossTenantFailure = yield* crossTenant.runtime
          .runRead({
            input: { ...request, tenantId: foreignTenantId },
            principal,
            registration: currentSupportedCurrenciesRead,
            transport: { correlationId: scope.correlationId },
          })
          .pipe(Effect.flip);

        expect(Predicate.isTagged(crossTenantFailure, 'ReadPermissionDenied')).toBe(true);
        expect(crossTenant.routineCalls).toEqual([]);
      }),
  );

  it.effect('denies exact Price resolution at the atomic permission gate before owner scope or handler execution', () =>
    Effect.gen(function* exactPricePermissionDeniedBeforeOwner() {
      const exactScope = { ...scope, legalEntityId } satisfies OperationalScope;
      const denied = yield* makeHarness({ operationalScope: exactScope, permissionDecision: 'denied' });
      const denial = yield* denied.runtime
        .runRead({
          input: exactPriceRequest,
          principal,
          registration: exactPriceResolutionRead,
          transport: { correlationId: scope.correlationId },
        })
        .pipe(Effect.flip);

      expect(Schema.is(ReadPermissionDenied)(denial)).toBe(true);
      expect(denied.contextPermissions).toEqual(['pricing.exact_price_resolution.read']);
      expect(denied.routineCalls).toEqual([]);
      expect(denied.stages).toEqual(['input_decoded', 'scope_validated', 'module_state_checked', 'permission_checked']);
      expect(denied.stages).not.toContain('scope_installed');
      expect(denied.stages).not.toContain('handler_executed');
    }),
  );
});
