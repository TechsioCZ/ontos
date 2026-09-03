import assert from 'node:assert/strict';
import test from 'node:test';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  CONTACTS_SCHEMA_NAME,
  CONTACTS_TABLE_INVENTORY,
  organizationEngagementProfiles,
  personEngagementProfiles,
} from '../../src/db/schema.ts';

const organizationConfig = getTableConfig(organizationEngagementProfiles);
const personConfig = getTableConfig(personEngagementProfiles);

test('owns exactly two engagement profile tables', () => {
  const qualifiedNames = [organizationConfig, personConfig]
    .map((config) => `${config.schema}.${config.name}`)
    .toSorted();
  assert.equal(CONTACTS_SCHEMA_NAME, 'contacts');
  assert.deepEqual(CONTACTS_TABLE_INVENTORY, [
    'organization_engagement_profiles',
    'person_engagement_profiles',
  ]);
  assert.deepEqual(qualifiedNames, [
    'contacts.organization_engagement_profiles',
    'contacts.person_engagement_profiles',
  ]);
});

test('stores references and profile lifecycle, never Party identity facts', () => {
  for (const config of [organizationConfig, personConfig]) {
    assert.deepEqual(
      config.columns.map((column) => column.name),
      [
        'engagement_profile_id',
        'tenant_id',
        'party_resource_id',
        'counterparty_resource_id',
        'created_at',
        'updated_at',
        'archived_at',
      ],
    );
    assert.equal(config.foreignKeys.length, 0);
    for (const forbidden of ['customer_id', 'contact_id', 'name', 'ico', 'dic', 'email', 'phone']) {
      assert.equal(
        config.columns.some((column) => column.name === forbidden),
        false,
      );
    }
    for (const required of [
      'engagement_profile_id',
      'tenant_id',
      'party_resource_id',
      'created_at',
      'updated_at',
    ]) {
      assert.equal(config.columns.find((column) => column.name === required)?.notNull, true);
    }
    assert.equal(
      config.columns.find((column) => column.name === 'counterparty_resource_id')?.notNull,
      false,
    );
  }
});

test('forces tenant RLS with complete CRUD policies on both profile tables', () => {
  for (const [config, prefix] of [
    [organizationConfig, 'contacts_organization_engagement_profiles_tenant'],
    [personConfig, 'contacts_person_engagement_profiles_tenant'],
  ] as const) {
    assert.equal(config.enableRLS, true);
    assert.deepEqual(
      config.policies.map((policy) => policy.name),
      [`${prefix}_select`, `${prefix}_insert`, `${prefix}_update`, `${prefix}_delete`],
    );
    assert.deepEqual(
      config.policies.map((policy) => policy.for),
      ['select', 'insert', 'update', 'delete'],
    );
    for (const policy of config.policies) {
      assert.equal(policy.to, 'ontos_runtime');
    }
  }
});
