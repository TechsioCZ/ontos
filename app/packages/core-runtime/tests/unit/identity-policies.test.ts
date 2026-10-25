import { NodeServices } from '@effect/platform-node';
import { getTableName, is } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect, PgRole } from 'drizzle-orm/pg-core';
import type { PgPolicy } from 'drizzle-orm/pg-core';
import { Effect, FileSystem, Option, Path, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { defineDatabaseIdentityEnrollment } from '../../src/db/database-identity-manifest.ts';
import type { DatabaseOwnerIdentityDescriptor } from '../../src/db/database-identity-manifest.ts';
import { makeCoreIdentityPolicies } from '../../src/db/identity-policies.ts';
import type { CoreIdentityPolicyDescriptor } from '../../src/db/identity-policies.ts';
import {
  applicationCompositionAuthority,
  coreDatabaseSchema,
  searchIndexEntries,
  searchProjectionGenerations,
  searchProjectionRebuilds,
} from '../../src/db/schema.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';

const dialect = new PgDialect();
const fixturePolicies = makeCoreIdentityPolicies(FIXTURE_DATABASE_IDENTITY_ENROLLMENT);
const searchTables = [searchIndexEntries, searchProjectionGenerations, searchProjectionRebuilds];
const renderPredicate = (predicate: SQL | undefined): string | null =>
  predicate === undefined ? null : dialect.sqlToQuery(predicate).sql;

const policyRoles = (to: PgPolicy['to']): readonly string[] => {
  if (to === undefined) {
    return ['public'];
  }
  if (Array.isArray(to)) {
    return to.flatMap(policyRoles);
  }
  return [is(to, PgRole) ? to.name : to];
};

const renderPolicy = ({ policy, table }: CoreIdentityPolicyDescriptor) => ({
  as: (policy.as ?? 'permissive').toUpperCase(),
  entityType: 'policies',
  for: (policy.for ?? 'all').toUpperCase(),
  name: policy.name,
  roles: policyRoles(policy.to).toSorted(),
  schema: 'core',
  table: getTableName(table),
  using: renderPredicate(policy.using),
  withCheck: renderPredicate(policy.withCheck),
});

const fixtureOwner = (moduleKey = 'fixture.stock', policyPrefix = 'stock'): DatabaseOwnerIdentityDescriptor => ({
  moduleKey,
  policyPrefix,
  request: {
    cloudflareHyperdrive: null,
    gatewayScopeAudiences: [`${policyPrefix}-fixture`],
    handlesBearerAssertions: true,
    id: `${policyPrefix}_request`,
    ownerModuleKey: moduleKey,
    registersGatewayScopeGrants: false,
    role: `${policyPrefix}_runtime`,
    scopeAuthority: 'gateway_grant',
    urlKey: `${policyPrefix.toUpperCase()}_DATABASE_URL`,
  },
  schemas: [`${policyPrefix}_fixture`],
  worker: {
    cloudflareHyperdrive: null,
    gatewayScopeAudiences: [],
    handlesBearerAssertions: false,
    id: `${policyPrefix}_worker`,
    ownerModuleKey: moduleKey,
    registersGatewayScopeGrants: false,
    role: `${policyPrefix}_worker`,
    scopeAuthority: 'session_setting',
    urlKey: `${policyPrefix.toUpperCase()}_WORKER_DATABASE_URL`,
  },
});

const PolicySnapshotSchema = Schema.Struct({
  as: Schema.String,
  entityType: Schema.Literal('policies'),
  for: Schema.String,
  name: Schema.String,
  roles: Schema.Array(Schema.String),
  schema: Schema.String,
  table: Schema.String,
  using: Schema.OptionFromNullOr(Schema.String),
  withCheck: Schema.OptionFromNullOr(Schema.String),
});
const decodePolicySnapshot = Schema.decodeUnknownSync(PolicySnapshotSchema);
const decodeSnapshotEntry = Schema.decodeUnknownSync(Schema.Struct({ entityType: Schema.String }));
const decodeSnapshot = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ ddl: Schema.Array(Schema.Unknown) })),
);

it.layer(NodeServices.layer)((suite) => {
  suite.effect(
    'retains every Core policy name, role, command and exact SQL predicate from the pre-extraction migration snapshot',
    () =>
      Effect.gen(function* policySnapshot() {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const snapshotPath = yield* path.fromFileUrl(
          new URL('../../drizzle/20261024223832_gateway-identity-attestation/snapshot.json', import.meta.url),
        );
        const snapshot = decodeSnapshot(yield* fileSystem.readFileString(snapshotPath));
        const expected = snapshot.ddl
          .filter((entry) => decodeSnapshotEntry(entry).entityType === 'policies')
          .map((entry) => decodePolicySnapshot(entry))
          .filter(({ schema }) => schema === 'core')
          .map((policy) => ({
            ...policy,
            roles: policy.roles.toSorted(),
            using: Option.getOrNull(policy.using),
            withCheck: Option.getOrNull(policy.withCheck),
          }))
          .toSorted((left, right) => left.name.localeCompare(right.name));
        const actual = [
          ...Object.values(coreDatabaseSchema).flatMap((table) =>
            getTableConfig(table).policies.map((policy) => renderPolicy({ policy, table })),
          ),
          ...fixturePolicies.map(renderPolicy),
        ].toSorted((left, right) => left.name.localeCompare(right.name));

        expect(expected).toHaveLength(59);
        expect(actual).toEqual(expected);
      }),
  );
});

it('keeps owner-dependent publication and all search policies out of import-time base tables', () => {
  expect(getTableConfig(applicationCompositionAuthority).policies).toEqual([]);
  for (const table of searchTables) {
    const config = getTableConfig(table);
    expect(config.enableRLS).toBe(true);
    // Even one permissive tenant-only base policy would admit dedicated-owner search rows.
    expect(config.policies).toEqual([]);
  }
});

it('builds independent frozen policy sets without mutating enrollment or table configuration', () => {
  const enrollment = FIXTURE_DATABASE_IDENTITY_ENROLLMENT;
  const before = Object.values(coreDatabaseSchema).map((table) => getTableConfig(table).policies);
  const first = makeCoreIdentityPolicies(enrollment);
  const other = makeCoreIdentityPolicies(defineDatabaseIdentityEnrollment([fixtureOwner('fixture.orders', 'orders')]));
  const second = makeCoreIdentityPolicies(enrollment);

  expect(Object.isFrozen(first)).toBe(true);
  expect(Object.isFrozen(enrollment)).toBe(true);
  expect(first.map(renderPolicy)).toEqual(second.map(renderPolicy));
  expect(first[0]?.policy).not.toBe(second[0]?.policy);
  expect(other.map(renderPolicy)).not.toEqual(first.map(renderPolicy));
  expect(Object.values(coreDatabaseSchema).map((table) => getTableConfig(table).policies)).toEqual(before);
  for (const descriptor of first) {
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.policy)).toBe(true);
    if (Array.isArray(descriptor.policy.to)) {
      expect(Object.isFrozen(descriptor.policy.to)).toBe(true);
    }
  }
});

it('excludes every enrolled owner from every shared-runtime search operation', () => {
  const enrollment = defineDatabaseIdentityEnrollment([fixtureOwner(), fixtureOwner('fixture.orders', 'orders')]);
  const descriptors = makeCoreIdentityPolicies(enrollment);
  const sharedPolicies = descriptors.filter(
    ({ policy, table }) => searchTables.some((candidate) => candidate === table) && policy.to === 'ontos_runtime',
  );
  expect(sharedPolicies).toHaveLength(10);
  for (const { policy } of sharedPolicies) {
    for (const predicate of [policy.using, policy.withCheck]) {
      if (predicate === undefined) {
        continue;
      }
      const query = dialect.sqlToQuery(predicate);
      expect(query.params).toEqual([]);
      expect(query.sql).toContain("nullif(current_setting('ontos.tenant_id', true), '')::uuid");
      expect(query.sql).toContain("<> 'fixture.stock'");
      expect(query.sql).toContain("<> 'fixture.orders'");
      expect(query.sql).not.toContain(' or ');
    }
  }
  const requests = descriptors.filter(({ policy }) => policy.to === 'stock_runtime');
  expect(requests.length).toBeGreaterThan(0);
  for (const { policy } of requests) {
    for (const predicate of [policy.using, policy.withCheck]) {
      expect(renderPredicate(predicate) ?? '').not.toContain('current_setting');
    }
  }
});

it('supports an explicitly empty enrollment without inventing owner policies', () => {
  const descriptors = makeCoreIdentityPolicies(defineDatabaseIdentityEnrollment([]));
  expect(descriptors).toHaveLength(11);
  expect(descriptors.find(({ table }) => table === applicationCompositionAuthority)?.policy.to).toEqual([
    'ontos_runtime',
  ]);
  for (const { policy, table } of descriptors) {
    if (!searchTables.some((candidate) => candidate === table)) {
      continue;
    }
    expect(policy.to).toBe('ontos_runtime');
    for (const predicate of [policy.using, policy.withCheck]) {
      if (predicate !== undefined) {
        expect(renderPredicate(predicate)).toContain("nullif(current_setting('ontos.tenant_id', true), '')::uuid");
        expect(renderPredicate(predicate)).not.toContain('source_module_key');
      }
    }
  }
});

it.each(["fixture.stock' or true --", 'Fixture.stock', 'fixture..stock', 'fixture_stock'])(
  'rejects a noncanonical owner module key before SQL interpolation: %s',
  (moduleKey) => {
    expect(() =>
      makeCoreIdentityPolicies({
        ...defineDatabaseIdentityEnrollment([]),
        owners: [fixtureOwner(moduleKey)],
      }),
    ).toThrow();
  },
);

it.each(['stock-name', "stock' or true --"])('rejects noncanonical owner policy prefixes: %s', (policyPrefix) => {
  expect(() =>
    makeCoreIdentityPolicies({
      ...defineDatabaseIdentityEnrollment([]),
      owners: [fixtureOwner('fixture.stock', policyPrefix)],
    }),
  ).toThrow();
});

it('rejects canonical policy prefixes that would produce PostgreSQL-truncated policy names', () => {
  expect(() =>
    makeCoreIdentityPolicies(defineDatabaseIdentityEnrollment([fixtureOwner('fixture.stock', 's'.repeat(30))])),
  ).toThrow(/canonical PostgreSQL identifier/u);
});

it('rejects a dedicated module inventory that could silently remove shared-search exclusions', () => {
  expect(() =>
    makeCoreIdentityPolicies({
      ...FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
      dedicatedModuleKeys: [],
    }),
  ).toThrow();
});
