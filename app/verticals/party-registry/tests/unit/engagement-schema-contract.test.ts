import { getTableConfig } from 'drizzle-orm/pg-core';
import { expect, it } from 'effect-rstest';

import {
  CONTACTS_SCHEMA_NAME,
  CONTACTS_TABLE_INVENTORY,
  organizationEngagementProfiles,
  personEngagementProfiles,
} from '../../src/db/engagement-schema.ts';

const organizationConfig = getTableConfig(organizationEngagementProfiles);
const personConfig = getTableConfig(personEngagementProfiles);

it('owns two engagement profile tables plus gateway replay protection', () => {
  const qualifiedNames = [organizationConfig, personConfig]
    .map((config) => `${config.schema}.${config.name}`)
    .toSorted();
  expect(CONTACTS_SCHEMA_NAME).toBe('contacts');
  expect(CONTACTS_TABLE_INVENTORY).toEqual([
    'gateway_assertion_redemptions',
    'organization_engagement_profiles',
    'person_engagement_profiles',
  ]);
  expect(qualifiedNames).toEqual([
    'contacts.organization_engagement_profiles',
    'contacts.person_engagement_profiles',
  ]);
});

it('stores references and profile lifecycle, never Party identity facts', () => {
  for (const config of [organizationConfig, personConfig]) {
    expect(config.columns.map((column) => column.name)).toEqual([
      'engagement_profile_id',
      'tenant_id',
      'party_resource_id',
      'counterparty_resource_id',
      'created_at',
      'updated_at',
      'archived_at',
    ]);
    expect(config.foreignKeys.length).toBe(0);
    for (const forbidden of [
      'customer_id',
      'contact_id',
      'name',
      'ico',
      'dic',
      'email',
      'phone',
    ]) {
      expect(config.columns.some((column) => column.name === forbidden)).toBe(
        false
      );
    }
    for (const required of [
      'engagement_profile_id',
      'tenant_id',
      'party_resource_id',
      'created_at',
      'updated_at',
    ]) {
      expect(
        config.columns.find((column) => column.name === required)?.notNull
      ).toBe(true);
    }
    expect(
      config.columns.find(
        (column) => column.name === 'counterparty_resource_id'
      )?.notNull
    ).toBe(false);
  }
});

it('forces tenant RLS with complete CRUD policies on both profile tables', () => {
  for (const [config, prefix] of [
    [organizationConfig, 'contacts_organization_engagement_profiles_tenant'],
    [personConfig, 'contacts_person_engagement_profiles_tenant'],
  ] as const) {
    expect(config.enableRLS).toBe(true);
    expect(config.policies.map((policy) => policy.name)).toEqual([
      `${prefix}_select`,
      `${prefix}_insert`,
      `${prefix}_update`,
      `${prefix}_delete`,
    ]);
    expect(config.policies.map((policy) => policy.for)).toEqual([
      'select',
      'insert',
      'update',
      'delete',
    ]);
    for (const policy of config.policies) {
      expect(policy.to).toBe('ontos_runtime');
    }
  }
});
