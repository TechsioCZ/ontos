import { getTableConfig } from 'drizzle-orm/pg-core';
import { Array as EffectArray, Order } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  COMMUNICATIONS_SCHEMA_NAME,
  COMMUNICATIONS_TABLE_INVENTORY,
  COMMUNICATIONS_TABLES,
} from '../../src/database/schema.ts';

const configs = COMMUNICATIONS_TABLES.map((table) => getTableConfig(table));

describe('Communications database schema contract', () => {
  it('owns exactly the inventoried tables in the communications schema', () => {
    expect(
      EffectArray.sort(
        configs.map((config) => config.name),
        Order.String,
      ),
    ).toEqual(EffectArray.sort(COMMUNICATIONS_TABLE_INVENTORY, Order.String));
    expect(configs.every((config) => config.schema === COMMUNICATIONS_SCHEMA_NAME)).toBe(true);
  });

  it('declares the replay ledger, the template tables, the language mode history and the intake tables, and no table of a later lane', () => {
    expect(COMMUNICATIONS_TABLE_INVENTORY).toEqual([
      'gateway_assertion_redemptions',
      'template_types',
      'template_revisions',
      'template_activations',
      'template_revision_invalidations',
      'tenant_language_mode_versions',
      'communication_requests',
      'communication_request_conflicts',
      'communication_decisions',
      'message_intents',
      'delivery_attempts',
      'intent_handoff_stops',
    ]);
  });

  it('keeps the Tenant language mode an append-only, Tenant-isolated version history with one number per Tenant', () => {
    const history = configs.find((config) => config.name === 'tenant_language_mode_versions');
    expect(history?.enableRLS).toBe(true);
    expect(history?.policies).toHaveLength(4);
    expect(history?.columns.some((column) => column.name === 'tenant_id' && column.notNull)).toBe(true);
    expect(history?.uniqueConstraints.map((constraint) => constraint.getName())).toEqual([
      'communications_language_mode_versions_number_uk',
    ]);
    expect(history?.checks.map((check) => check.name).toSorted()).toEqual([
      'communications_language_mode_versions_mode_ck',
      'communications_language_mode_versions_number_ck',
    ]);
    // the mode is the whole business fact: no free text, no language, no template or recipient data
    expect(history?.columns.map((column) => column.name).toSorted()).toEqual([
      'action_invocation_id',
      'mode',
      'policy_version_id',
      'set_at',
      'set_by_principal_id',
      'tenant_id',
      'version_number',
    ]);
  });

  it('enforces Tenant RLS on every template table, one open activation per Type and the Type identity', () => {
    const template = Object.fromEntries(configs.map((config) => [config.name, config]));
    for (const name of [
      'template_types',
      'template_revisions',
      'template_activations',
      'template_revision_invalidations',
    ]) {
      expect(template[name]?.enableRLS).toBe(true);
      expect(template[name]?.policies).toHaveLength(4);
      expect(template[name]?.columns.some((column) => column.name === 'tenant_id' && column.notNull)).toBe(true);
    }
    expect(template['template_types']?.uniqueConstraints.map((constraint) => constraint.getName())).toContain(
      'communications_template_types_identity_uk',
    );
    expect(template['template_revisions']?.uniqueConstraints.map((constraint) => constraint.getName())).toContain(
      'communications_template_revisions_number_uk',
    );
    const open = template['template_activations']?.indexes.find(
      (index) => index.config.name === 'communications_template_activations_open_uk',
    );
    expect(open?.config.unique).toBe(true);
    expect(open?.config.where).toBeDefined();
  });

  it('keeps the Type identity-only and gives every revision its own declared placeholders', () => {
    const columnsOf = (name: string) =>
      configs.find((config) => config.name === name)?.columns.map((column) => column.name);
    expect(columnsOf('template_types')).not.toContain('required_placeholders');
    expect(columnsOf('template_types')).not.toContain('optional_placeholders');
    expect(columnsOf('template_revisions')).toEqual(
      expect.arrayContaining(['required_placeholders', 'optional_placeholders', 'placeholders_used']),
    );
    expect(
      configs
        .find((config) => config.name === 'template_revisions')
        ?.columns.filter((column) => column.notNull)
        .map((column) => column.name),
    ).toEqual(expect.arrayContaining(['required_placeholders', 'optional_placeholders']));
  });

  it('ties an activation to the Type and scope of its own revision with composite keys', () => {
    const activations = configs.find((config) => config.name === 'template_activations');
    const foreignKeys = Object.fromEntries(
      (activations?.foreignKeys ?? []).map((key) => {
        const reference = key.reference();
        return [key.getName(), reference.columns.map((column) => column.name)];
      }),
    );
    expect(foreignKeys).toEqual({
      communications_template_activations_revision_fk: ['tenant_id', 'revision_id', 'template_type_id'],
      communications_template_activations_type_fk: ['tenant_id', 'template_type_id', 'scope_key'],
    });
    expect(activations?.checks.map((check) => check.name)).toEqual(
      expect.arrayContaining([
        'communications_template_activations_end_ck',
        'communications_template_activations_scope_ck',
      ]),
    );
  });

  it('keeps the replay ledger a Tenant-free table with one replay identity and an expiry index', () => {
    const redemptions = configs.find((config) => config.name === 'gateway_assertion_redemptions');

    expect(redemptions?.enableRLS).toBe(false);
    expect(redemptions?.columns.map((column) => column.name)).toEqual([
      'audience',
      'expires_at',
      'issuer',
      'jti',
      'redeemed_at',
    ]);
    expect(redemptions?.uniqueConstraints.map((constraint) => constraint.getName())).toEqual([
      'communications_gateway_assertion_redemptions_identity_uk',
    ]);
    expect(redemptions?.indexes.map((index) => index.config.name)).toEqual([
      'communications_gateway_assertion_redemptions_expiry_idx',
    ]);
  });
});

describe('Communications intake schema contract (#1401)', () => {
  const byName = Object.fromEntries(configs.map((config) => [config.name, config]));
  const unique = (table: string) => byName[table]?.uniqueConstraints.map((constraint) => constraint.getName());

  it('enforces forced-RLS-ready Tenant isolation on every intake table', () => {
    for (const name of [
      'communication_requests',
      'communication_request_conflicts',
      'communication_decisions',
      'message_intents',
      'delivery_attempts',
      'intent_handoff_stops',
    ]) {
      expect(byName[name]?.enableRLS).toBe(true);
      expect(byName[name]?.policies).toHaveLength(4);
      expect(byName[name]?.columns.some((column) => column.name === 'tenant_id' && column.notNull)).toBe(true);
    }
  });

  it('keys a request by its business identity only, never by a transport or invocation id (I-02)', () => {
    expect(unique('communication_requests')).toEqual(
      expect.arrayContaining(['communications_requests_identity_key_uk']),
    );
    const identityColumns = byName['communication_requests']?.uniqueConstraints
      .find((constraint) => constraint.getName() === 'communications_requests_identity_key_uk')
      ?.columns.map((column) => column.name);
    expect(identityColumns).toEqual(['tenant_id', 'identity_key']);
  });

  it('gives a request exactly one decision and an intent exactly one stable identity key', () => {
    expect(unique('communication_decisions')).toContain('communications_decisions_request_uk');
    expect(unique('message_intents')).toContain('communications_intents_key_uk');
    expect(unique('delivery_attempts')).toContain('communications_attempts_number_uk');
    expect(unique('intent_handoff_stops')).toContain('communications_handoff_stops_intent_uk');
  });

  it('pins everything a pending intent needs for its last stoppable handoff', () => {
    expect(byName['message_intents']?.checks.map((check) => check.name)).toEqual(
      expect.arrayContaining(['communications_intents_pending_pins_ck', 'communications_intents_reason_ck']),
    );
    expect(byName['message_intents']?.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'original_binding',
        'endpoint_pin',
        'processing_scope',
        'language_decision',
        'template_revision_id',
        'tenant_mode',
        'policy_ref',
      ]),
    );
  });

  it('stores no endpoint address: the endpoint pin has no value column, only references and a mask in JSON', () => {
    const names = byName['message_intents']?.columns.map((column) => column.name) ?? [];
    expect(names.filter((name) => /address|email|secret|token|otp/u.test(name))).toEqual([]);
  });
});
