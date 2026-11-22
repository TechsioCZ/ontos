import { findPostgresFailure, loadDatabaseConnectionPair } from '@app/core-runtime';
import { NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import type { PriceIdentityKey } from '@app/pricing-contracts/domain/price-definition';
import type { PriceSourceAuthority, PriceSourceMapping } from '@app/pricing-contracts/domain/price-source-provenance';
import { Crypto, Effect, FileSystem, Option } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeTestPgClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import {
  erpAuthority,
  policyTerms,
  priceGroupRef,
  priceKey,
  productMapping,
  sourceAssertionFor,
} from '../support/standing-price-source-policy.fixture.ts';

const history = [
  '20261001163700_external-price-source-authority-v1',
  '20261001164414_external-price-source-authority-runtime-v1',
  '20261116083947_pricing-source-effective-time-and-normalized-grant-identity',
  '20261122090000_external-price-source-policy-v1',
  '20261122090100_external-price-source-policy-runtime-v1',
  '20261122090200_external-price-source-policy-storage-guards',
  '20261122090300_external-price-assessment-group-tenant',
  '20261122090400_external_price_policy_value_guards',
];
const forward = '20261122090500_external_price_authority_canonical_keys';
const root = new URL('../../drizzle/', import.meta.url);
const migrate = Effect.fn('PricingGrantUpgrade.migrate')(function* migrate(
  admin: PgClient.PgClient,
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const migration = yield* fs.readFileString(new URL(`${directory}/migration.sql`, root).pathname);
  // These owner migrations contain only transactional DDL. One DO command executes the file
  // verbatim, including the old multi-command migration without Drizzle breakpoint markers.
  yield* admin.unsafe(`do $pricing_upgrade$ begin\n${migration}\nend $pricing_upgrade$;`);
});

const world = {
  legalEntityId: 'ab000000-0000-4000-8000-000000000001',
  tenantId: 'ab000000-0000-4000-8000-000000000002',
  unitId: 'ab000000-0000-4000-8000-000000000003',
};
const groupId = 'ab000000-0000-4000-8000-000000000004';
const key = (n: number, upperUnit = false, upperGroup = false) =>
  priceKey(
    { ...world, unitId: upperUnit ? world.unitId.toUpperCase() : world.unitId },
    {
      productId: 'ab000000-0000-4000-8000-000000000005',
      variantId: `ab000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    },
    {
      priceGroupSelector: {
        kind: 'PRICE_GROUP',
        priceGroupRef: priceGroupRef(world.tenantId, upperGroup ? groupId.toUpperCase() : groupId),
      },
    },
  );
const effectiveAt = '2026-11-10T00:00:00.000Z';
const evidence = {
  effectivePeriod: { effectiveFrom: effectiveAt, effectiveTo: '2026-11-11T00:00:00.000Z' },
  family: 'PRICE',
  ownerModuleId: 'commerce.pricing',
  schemaVersion: '1',
  verificationRef: 'historic-proof',
  verifiedAt: '2026-11-01T00:00:00.000Z',
};
const authority: PriceSourceAuthority = erpAuthority;
const mapping: PriceSourceMapping = productMapping;
const grant = (exactIdentityKey: PriceIdentityKey, verificationRef = evidence.verificationRef) => ({
  ...evidence,
  authority,
  exactIdentityKey,
  mapping,
  verificationRef,
});
const databaseUrl = (connection: string, name: string) => {
  const url = new URL(connection);
  url.pathname = `/${name}`;
  return url.href;
};

it.layer(NodeServices.layer, { excludeTestServices: true })('Pricing grant storage upgrade', (suite) => {
  suite.effect(
    'upgrades immutable grants and legacy policy references without rewriting history or weakening new writes',
    () =>
      Effect.scoped(
        Effect.gen(function* upgrade() {
          const connections = yield* loadDatabaseConnectionPair({
            envPath: `${import.meta.filename}.no-environment-file`,
          });
          const bootstrap = yield* makeTestPgClient(connections.admin.connectionString);
          const name = `pricing_grant_${(yield* (yield* Crypto.Crypto).randomUUIDv4()).replaceAll('-', '')}`;
          yield* bootstrap.unsafe(`create database "${name}"`);
          yield* Effect.addFinalizer(() => bootstrap.unsafe(`drop database "${name}" with (force)`).pipe(Effect.orDie));
          const admin = yield* makeTestPgClient(databaseUrl(connections.admin.connectionString, name));
          const runtime = yield* makeTestPgClient(databaseUrl(connections.runtime.connectionString, name));
          yield* admin`create schema pricing`;
          yield* admin`grant usage on schema pricing to ontos_runtime`;
          for (const step of history) {
            yield* migrate(admin, step);
          }
          const scoped = <A, E>(effect: Effect.Effect<A, E>) =>
            runtime.withTransaction(
              Effect.andThen(
                runtime`select set_config('ontos.tenant_id', ${world.tenantId}, true), set_config('ontos.legal_entity_id', ${world.legalEntityId}, true)`,
                effect,
              ),
            );
          const store = (input: ReturnType<typeof grant>) =>
            scoped(
              runtime`select payload from pricing.store_external_price_source_authority_grant_v1(${world.tenantId}::uuid, ${world.legalEntityId}::uuid, ${runtime.json(input)})`,
            );
          const historyRows = scoped(
            runtime`select to_jsonb(g) as row from pricing.external_price_source_authority_grants g order by grant_id`,
          );
          const upper = grant(key(11, true, true));
          const pairUpper = grant(key(12, true, true), 'first receipt');
          const pairLower = grant(key(12), 'second receipt');
          const historicWildcards = [
            { ...grant(key(21)), authority: { ...erpAuthority, sourceAuthorityRef: '*' } },
            { ...grant(key(22)), authority: { ...erpAuthority, sourceAuthorityVersion: '*' } },
            { ...grant(key(23)), mapping: { ...productMapping, mappingContractRef: '*' } },
            { ...grant(key(24)), mapping: { ...productMapping, mappingContractVersion: '*' } },
          ];
          for (const stored of [upper, pairUpper, pairLower, ...historicWildcards]) {
            expect(yield* store(stored)).toEqual([{ payload: { outcome: 'STORED' } }]);
          }
          const policy = { ...evidence, ...policyTerms(world, { priceGroupCoverage: { kind: 'ANY_PRICE_GROUP' } }) };
          expect(
            yield* scoped(
              runtime`select payload from pricing.store_external_price_source_policy_v1(${world.tenantId}::uuid, ${world.legalEntityId}::uuid, ${runtime.json(policy)})`,
            ),
          ).toMatchObject([{ payload: { outcome: 'STORED' } }]);
          const historicPolicy = {
            ...policy,
            commercialScope: { ...policy.commercialScope, marketId: 'legacy-verification' },
            verificationRef: 'historic-proof\t',
          };
          expect(
            yield* scoped(
              runtime`select payload from pricing.store_external_price_source_policy_v1(${world.tenantId}::uuid, ${world.legalEntityId}::uuid, ${runtime.json(historicPolicy)})`,
            ),
          ).toMatchObject([{ payload: { outcome: 'STORED' } }]);
          const policyRows = scoped(
            runtime`select to_jsonb(p) as row from pricing.external_price_source_policies p order by policy_id`,
          );
          const policiesBefore = yield* policyRows;
          expect(policiesBefore).toHaveLength(2);
          const before = yield* historyRows;
          expect(before).toHaveLength(7);
          yield* migrate(admin, forward);
          expect(yield* historyRows).toEqual(before);
          expect(yield* policyRows).toEqual(policiesBefore);
          expect(
            yield* admin`select convalidated from pg_catalog.pg_constraint
              where conrelid='pricing.external_price_source_authority_grants'::regclass
                and conname='pricing_external_price_authority_exact_refs_ck'`,
          ).toEqual([{ convalidated: false }]);
          expect(
            yield* admin`select convalidated from pg_catalog.pg_constraint
              where conrelid='pricing.external_price_source_policies'::regclass
                and conname='pricing_external_price_policies_verification_ref_ck'`,
          ).toEqual([{ convalidated: false }]);
          const invalidNewPolicy = {
            ...historicPolicy,
            commercialScope: { ...historicPolicy.commercialScope, marketId: 'new-verification' },
          };
          const rejectedPolicy = yield* Effect.flip(
            scoped(
              runtime`select payload from pricing.store_external_price_source_policy_v1(${world.tenantId}::uuid, ${world.legalEntityId}::uuid, ${runtime.json(invalidNewPolicy)})`,
            ),
          );
          expect(Option.getOrThrow(findPostgresFailure(rejectedPolicy)).code).toBe('23514');
          for (const historic of historicWildcards) {
            const denied = yield* Effect.flip(store({ ...historic, exactIdentityKey: key(25) }));
            expect(Option.getOrThrow(findPostgresFailure(denied)).code).toBe('23514');
          }
          const assess = (exactIdentityKey: PriceIdentityKey, at = effectiveAt) => {
            const input = {
              exactIdentityKey,
              sourceAssertion: sourceAssertionFor(exactIdentityKey, {
                effectiveAt: at,
                sourceAssertionId: 'ab000000-0000-4000-8000-000000000006',
              }),
              tenantId: world.tenantId,
              trustedOperationAt: at,
            };
            return scoped(
              runtime`select payload from pricing.assess_external_price_source_authority_v1(${world.tenantId}::uuid, ${world.legalEntityId}::uuid, ${runtime.json(input)})`,
            );
          };
          expect(yield* assess(key(11))).toEqual([
            { payload: { grant: grant(key(11)), outcome: 'AUTHORITY_GRANTED' } },
          ]);
          const held = [{ payload: { outcome: 'AUTHORITY_UNRESOLVED', reason: 'AUTHORITY' } }];
          expect(yield* assess(key(12))).toEqual(held);
          for (const variant of [21, 22, 23, 24]) {
            expect(yield* assess(key(variant))).toEqual(held);
          }
          expect(yield* assess(key(11), evidence.effectivePeriod.effectiveTo)).toEqual(held);
          expect(yield* assess(key(13))).toMatchObject([{ payload: { outcome: 'AUTHORITY_COVERED_BY_POLICY' } }]);
          for (const retry of [upper, grant(key(11)), pairUpper, pairLower]) {
            expect(yield* store(retry)).toEqual([{ payload: { outcome: 'REUSED' } }]);
          }
          const conflict = [{ payload: { outcome: 'CONFLICT', reason: 'GRANT_IDENTITY_ALREADY_BOUND' } }];
          expect(yield* store(grant(key(11), 'changed verification'))).toEqual(conflict);
          expect(yield* store(grant(key(12, true), 'first receipt'))).toEqual(conflict);
          expect(yield* historyRows).toEqual(before);
          expect(yield* policyRows).toEqual(policiesBefore);
          expect(yield* store(grant(key(14, true)))).toEqual([{ payload: { outcome: 'STORED' } }]);
          expect(yield* store(grant(key(14)))).toEqual([{ payload: { outcome: 'REUSED' } }]);
          expect(
            yield* scoped(
              runtime`select exact_identity_key as key from pricing.external_price_source_authority_grants where exact_identity_key #>> '{catalogSelection,variantRef,resourceId}' = ${key(14).catalogSelection.variantRef.resourceId}`,
            ),
          ).toEqual([{ key: key(14) }]);
          expect(yield* assess(key(14))).toEqual([
            { payload: { grant: grant(key(14)), outcome: 'AUTHORITY_GRANTED' } },
          ]);
        }),
      ),
  );
});
