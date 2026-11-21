import type { OperationalScope } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { PriceIdentityKey } from '@app/pricing-contracts/domain/price-definition';
import { sql } from 'drizzle-orm';
import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import type { ExternalPriceSourcePolicyTerms } from '../../shared/domain/external-price-source-policy.ts';
import {
  ExternalPriceSourcePolicyConflict,
  applyManageExternalPriceSourcePolicy,
} from '../../src/actions/manage-external-price-source-policy.action.ts';
import type { ManageExternalPriceSourcePolicyPayload } from '../../src/actions/manage-external-price-source-policy.action.ts';
import { externalPriceSourceAuthorityForScope } from '../../src/persistence/external-price-source-authority-persistence.ts';
import type { ExternalPriceSourceAuthorityPersistence } from '../../src/persistence/external-price-source-authority-persistence.ts';
import { makeExternalPriceInputBoundary } from '../../src/services/external-price-input-boundary.service.ts';
import {
  erpAuthority,
  priceGroupRef,
  priceKey,
  priceListMapping,
  policyTerms,
  productMapping,
  sourceAssertionFor,
  unitRefFor,
} from '../support/standing-price-source-policy.fixture.ts';

const tenantId = 'f2000000-0000-4000-8000-000000000001';
const legalEntityId = 'f2000000-0000-4000-8000-000000000002';
const otherLegalEntityId = 'f2000000-0000-4000-8000-000000000003';
const world = { legalEntityId, tenantId, unitId: 'f2000000-0000-4000-8000-000000000004' };
const otherWorld = { ...world, legalEntityId: otherLegalEntityId };
const groupId = 'f2000000-0000-4000-8000-000000000021';

type PricingTestDatabase = TestDatabaseFromClient<typeof coreRelations>;
type PricingTransaction = Parameters<Parameters<PricingTestDatabase['transaction']>[0]>[0];

const instant = (value: string) => DateTime.toDateUtc(DateTime.makeUnsafe(value));

const scopeFor = (selectedLegalEntityId: string): OperationalScope => ({
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: tenantId,
    authContextRef: `session:external-price-source-policy:${selectedLegalEntityId}`,
    authMethod: 'session',
    legalEntityId: selectedLegalEntityId,
    principalId: 'f2000000-0000-4000-8000-000000000005',
    tenantId,
  }),
  correlationId: `external-price-source-policy:${selectedLegalEntityId}`,
});
const scope = scopeFor(legalEntityId);
const otherScope = scopeFor(otherLegalEntityId);

const withAuthority = <Value, Failure>(
  database: PricingTestDatabase,
  selectedScope: OperationalScope,
  operation: (authority: ExternalPriceSourceAuthorityPersistence) => Effect.Effect<Value, Failure>,
) =>
  database.transaction((transaction: PricingTransaction) =>
    Effect.gen(function* scopedAuthority() {
      yield* transaction.execute(
        sql`select set_config('ontos.tenant_id', ${selectedScope.tenantId}, true),
                   set_config('ontos.legal_entity_id', ${selectedScope.legalEntityId ?? ''}, true)`,
        'objects',
      );
      const ownerTransaction = yield* installOperationalScope(transaction, selectedScope);
      const authority = yield* externalPriceSourceAuthorityForScope(ownerTransaction, selectedScope);
      return yield* operation(authority);
    }),
  );

/** The Action's own decision, run against the registered scoped persistence as the runtime role under RLS. */
const manage = (
  runtime: PricingTestDatabase,
  payload: ManageExternalPriceSourcePolicyPayload,
  trustedOperationAt: string,
  selectedScope: OperationalScope = scope,
) =>
  withAuthority(runtime, selectedScope, (authority) =>
    applyManageExternalPriceSourcePolicy(
      payload,
      {
        legalEntityId: selectedScope.legalEntityId,
        tenantId: selectedScope.tenantId,
        trustedOperationAt: instant(trustedOperationAt),
      },
      authority,
    ),
  );

const establish = (
  runtime: PricingTestDatabase,
  policy: ExternalPriceSourcePolicyTerms,
  verificationRef: string,
  selectedScope: OperationalScope = scope,
) =>
  manage(
    runtime,
    { intent: 'ESTABLISH', policy, reason: 'The ERP is the verified source of these Prices.', verificationRef },
    '2026-11-01T00:00:00.000Z',
    selectedScope,
  );

let assertionSequence = 0;
/** The same boundary Define Price, Revise Price and the bulk Price Action build from this persistence. */
const assessPrice = (
  runtime: PricingTestDatabase,
  key: PriceIdentityKey,
  effectiveAt: string,
  mapping: typeof priceListMapping | typeof productMapping = productMapping,
) => {
  assertionSequence += 1;
  const sourceAssertion = sourceAssertionFor(key, {
    effectiveAt,
    mapping,
    sourceAssertionId: `f2000000-0000-4000-8000-${String(assertionSequence).padStart(12, '0')}`,
  });
  return withAuthority(runtime, scope, (authority) =>
    makeExternalPriceInputBoundary(authority).assess({
      actingPrincipalId: scope.principalId,
      effectiveFrom: effectiveAt,
      identityKey: key,
      monetaryAmount: { amount: '199.90', currencyCode: key.currencyCode },
      sourceAssertion,
      tenantId,
      trustedOperationAt: instant('2026-11-20T10:00:00.000Z'),
    }),
  );
};

const neverSeenVariant = (suffix: number) => ({
  productId: `f2000000-0000-4000-8000-0000000001${String(suffix).padStart(2, '0')}`,
  variantId: `f2000000-0000-4000-8000-0000000002${String(suffix).padStart(2, '0')}`,
});

const cleanup = (admin: PricingTestDatabase) =>
  Effect.all([
    admin.execute(sql`delete from pricing.external_price_source_policy_ends where tenant_id = ${tenantId}::uuid`),
    admin.execute(sql`delete from pricing.external_price_source_policies where tenant_id = ${tenantId}::uuid`),
    admin.execute(sql`delete from pricing.external_price_source_authority_grants where tenant_id = ${tenantId}::uuid`),
  ]);

it.live('a standing source policy accepts never-seen variants, denies keys outside its scope, and ends', () =>
  Effect.scoped(
    Effect.gen(function* standingSourcePolicyPostgres() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      yield* cleanup(admin);
      yield* Effect.addFinalizer(() => cleanup(admin).pipe(Effect.orDie));

      const baseVariant = neverSeenVariant(1);
      const baseKey = priceKey(world, baseVariant);
      // Before any policy a never-seen variant is held, exactly like any ungranted key.
      const ungranted = yield* assessPrice(runtime, baseKey, '2026-11-10T00:00:00.000Z');
      expect(ungranted).toMatchObject({
        outcome: 'PRICE_SOURCE_ASSERTION_UNRESOLVED_HELD',
        reason: 'SOURCE_AUTHORITY_UNRESOLVED',
      });

      // One base-Price policy and one policy for every Price Group the source creates, set once.
      const basePolicy = yield* establish(runtime, policyTerms(world), 'akros-erp-base-prices');
      expect(basePolicy).toMatchObject({ intent: 'ESTABLISH', outcome: 'STORED' });
      // The same terms again store nothing and answer with the policy already there.
      expect(yield* establish(runtime, policyTerms(world), 'akros-erp-base-prices')).toEqual({
        ...basePolicy,
        outcome: 'REUSED',
      });
      const groupPolicy = yield* establish(
        runtime,
        policyTerms(world, { mapping: priceListMapping, priceGroupCoverage: { kind: 'ANY_PRICE_GROUP' } }),
        'akros-erp-price-list-prices',
      );
      expect(groupPolicy).toMatchObject({ intent: 'ESTABLISH', outcome: 'STORED' });

      // A never-seen variant is accepted with no per-item step, for its base Price and its price-list Price.
      const accepted = yield* assessPrice(runtime, baseKey, '2026-11-10T00:00:00.000Z');
      expect(accepted.outcome).toBe('READY_FOR_CANONICAL_WRITE');
      const otherVariantKey = priceKey(world, neverSeenVariant(2), {
        unitBasis: { quantity: '1.000000000', unitRef: unitRefFor(world) },
      });
      expect((yield* assessPrice(runtime, otherVariantKey, '2026-11-10T00:00:00.000Z')).outcome).toBe(
        'READY_FOR_CANONICAL_WRITE',
      );
      const groupKey = priceKey(world, neverSeenVariant(3), {
        priceGroupSelector: { kind: 'PRICE_GROUP', priceGroupRef: priceGroupRef(tenantId, groupId) },
      });
      expect((yield* assessPrice(runtime, groupKey, '2026-11-10T00:00:00.000Z', priceListMapping)).outcome).toBe(
        'READY_FOR_CANONICAL_WRITE',
      );
      // The incoming row cannot pick the policy: a group Price claiming the base mapping is not covered.
      expect(yield* assessPrice(runtime, groupKey, '2026-11-10T00:00:00.000Z')).toMatchObject({
        outcome: 'PRICE_SOURCE_ASSERTION_UNRESOLVED_HELD',
        reason: 'SOURCE_AUTHORITY_UNRESOLVED',
      });

      // Outside the scope (market, channel, currency, unit, unit quantity) is denied exactly as an ungranted key.
      const outside = [
        priceKey(world, baseVariant, { commercialScope: { ...baseKey.commercialScope, marketId: 'akros-sk' } }),
        priceKey(world, baseVariant, { commercialScope: { ...baseKey.commercialScope, channelId: 'B2B' } }),
        priceKey(world, baseVariant, { currencyCode: 'EUR' }),
        priceKey(world, baseVariant, {
          unitBasis: { quantity: '1', unitRef: unitRefFor(world, 'f2000000-0000-4000-8000-000000000006') },
        }),
        priceKey(world, baseVariant, { unitBasis: { quantity: '10', unitRef: unitRefFor(world) } }),
      ];
      for (const key of outside) {
        expect(yield* assessPrice(runtime, key, '2026-11-10T00:00:00.000Z')).toMatchObject({
          outcome: 'PRICE_SOURCE_ASSERTION_UNRESOLVED_HELD',
          reason: 'SOURCE_AUTHORITY_UNRESOLVED',
        });
      }
      // Another company's key is refused in this company's context, as it is for any ungranted key.
      expect(yield* assessPrice(runtime, priceKey(otherWorld, baseVariant), '2026-11-10T00:00:00.000Z')).toMatchObject({
        outcome: 'PRICE_SOURCE_ASSERTION_KNOWN_INVALID',
        reason: 'MAPPING_REJECTED',
      });
      // Before the policy starts nothing is covered.
      expect(yield* assessPrice(runtime, baseKey, '2026-10-31T23:59:59.999Z')).toMatchObject({
        outcome: 'PRICE_SOURCE_ASSERTION_UNRESOLVED_HELD',
      });

      // Overlapping coverage is refused, whatever authority or mapping the second policy names.
      for (const overlapping of [
        policyTerms(world, {
          authority: { ...erpAuthority, sourceAuthorityVersion: 'v2' },
          effectivePeriod: { effectiveFrom: '2026-12-01T00:00:00.000Z' },
        }),
        policyTerms(world, {
          mapping: priceListMapping,
          priceGroupCoverage: { kind: 'PRICE_GROUP', priceGroupRef: priceGroupRef(tenantId, groupId) },
        }),
      ]) {
        const refused = yield* establish(runtime, overlapping, 'overlapping-policy').pipe(Effect.flip);
        expect(refused).toBeInstanceOf(ExternalPriceSourcePolicyConflict);
        expect(refused).toMatchObject({ code: 'external_price_source_policy_overlap' });
      }
      // Another company is its own scope and stores its own policy.
      expect(yield* establish(runtime, policyTerms(otherWorld), 'other-company', otherScope)).toMatchObject({
        outcome: 'STORED',
      });

      // Ending the base policy: an end in the past is refused, then it ends from 2026-11-25.
      const basePolicyId =
        basePolicy.intent === 'ESTABLISH' ? basePolicy.policyId : yield* Effect.die('expected an established policy');
      const end = (effectiveTo: string, verificationRef = 'akros-erp-base-prices-end') =>
        manage(
          runtime,
          {
            effectiveTo,
            intent: 'END',
            policyId: basePolicyId,
            reason: 'The ERP stops being the base Price source.',
            verificationRef,
          },
          '2026-11-20T10:00:00.000Z',
        );
      expect(yield* end('2026-11-19T00:00:00.000Z').pipe(Effect.flip)).toMatchObject({
        code: 'external_price_source_policy_end_outside_period',
      });
      expect(yield* end('2026-11-25T00:00:00.000Z')).toEqual({
        effectiveTo: '2026-11-25T00:00:00.000Z',
        intent: 'END',
        outcome: 'ENDED',
        policyId: basePolicyId,
      });
      expect((yield* end('2026-11-25T00:00:00.000Z')).outcome).toBe('REUSED');
      expect(yield* end('2026-11-26T00:00:00.000Z').pipe(Effect.flip)).toMatchObject({
        code: 'external_price_source_policy_already_ended',
      });

      // The ended policy denies from its end; before it the same key stays accepted.
      expect(yield* assessPrice(runtime, baseKey, '2026-11-25T00:00:00.000Z')).toMatchObject({
        outcome: 'PRICE_SOURCE_ASSERTION_UNRESOLVED_HELD',
        reason: 'SOURCE_AUTHORITY_UNRESOLVED',
      });
      expect((yield* assessPrice(runtime, baseKey, '2026-11-24T23:59:59.999Z')).outcome).toBe(
        'READY_FOR_CANONICAL_WRITE',
      );
      // A successor may start where the ended policy stops.
      expect(
        yield* establish(
          runtime,
          policyTerms(world, {
            authority: { ...erpAuthority, sourceAuthorityVersion: 'v2' },
            effectivePeriod: { effectiveFrom: '2026-11-25T00:00:00.000Z' },
          }),
          'akros-erp-base-prices-v2',
        ),
      ).toMatchObject({ outcome: 'STORED' });

      // Rows are scoped: each company sees only its own policies.
      const counts = yield* Effect.forEach([scope, otherScope], (selectedScope) =>
        runtime.transaction((transaction) =>
          Effect.gen(function* scopedCount() {
            yield* transaction.execute(
              sql`select set_config('ontos.tenant_id', ${selectedScope.tenantId}, true),
                         set_config('ontos.legal_entity_id', ${selectedScope.legalEntityId ?? ''}, true)`,
            );
            return yield* transaction.execute<{ readonly count: number }>(
              sql`select count(*)::integer as count from pricing.external_price_source_policies`,
              'objects',
            );
          }),
        ),
      );
      expect(counts).toEqual([[{ count: 3 }], [{ count: 1 }]]);
    }),
  ),
);

it.live('an exact-key grant keeps deciding on its own when a standing policy also covers the key', () =>
  Effect.scoped(
    Effect.gen(function* exactGrantFirst() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      yield* cleanup(admin);
      yield* Effect.addFinalizer(() => cleanup(admin).pipe(Effect.orDie));

      const key = priceKey(world, neverSeenVariant(9));
      yield* establish(runtime, policyTerms(world), 'akros-erp-base-prices');
      const grant = {
        authority: erpAuthority,
        effectivePeriod: { effectiveFrom: '2026-11-01T00:00:00.000Z' },
        exactIdentityKey: key,
        family: 'PRICE' as const,
        mapping: policyTerms(world).mapping,
        ownerModuleId: 'commerce.pricing' as const,
        schemaVersion: '1' as const,
        verificationRef: 'exact-grant',
        verifiedAt: '2026-11-01T00:00:00.000Z',
      };
      expect(yield* withAuthority(runtime, scope, (authority) => authority.store(grant))).toEqual({
        outcome: 'STORED',
      });
      const assessment = (selectedKey: PriceIdentityKey) =>
        withAuthority(runtime, scope, (authority) =>
          authority.assess({
            exactIdentityKey: selectedKey,
            sourceAssertion: sourceAssertionFor(selectedKey, {
              effectiveAt: '2026-11-10T00:00:00.000Z',
              sourceAssertionId: 'f2000000-0000-4000-8000-000000000999',
            }),
            tenantId,
            trustedOperationAt: instant('2026-11-20T10:00:00.000Z'),
          }),
        );
      expect(yield* assessment(key)).toEqual({ grant, outcome: 'AUTHORITY_GRANTED' });
      expect(yield* assessment(priceKey(world, neverSeenVariant(8)))).toMatchObject({
        outcome: 'AUTHORITY_COVERED_BY_POLICY',
        policy: { unitBasis: { quantity: '1.000000000' }, verificationRef: 'akros-erp-base-prices' },
      });
    }),
  ),
);
