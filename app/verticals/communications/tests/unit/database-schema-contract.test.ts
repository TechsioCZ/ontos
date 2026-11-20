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

  it('declares the replay ledger, the template tables, the language mode history, the intake tables, the history tables and the recovery tables, and no table of a later lane', () => {
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
      'provider_observations',
      'provider_observation_conflicts',
      'provider_observation_conflict_resolutions',
      'intent_recovery_evaluations',
      'intent_document_pins',
      'attempt_retry_links',
      'intent_resend_links',
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
    // a stop is keyed by (intent, evaluation), never by the intent alone: a later Current evaluation is representable
    expect(unique('intent_handoff_stops')).toContain('communications_handoff_stops_evaluation_uk');
    expect(unique('intent_handoff_stops')).not.toContain('communications_handoff_stops_intent_uk');
    expect(
      byName['intent_handoff_stops']?.uniqueConstraints
        .find((constraint) => constraint.getName() === 'communications_handoff_stops_evaluation_uk')
        ?.columns.map((column) => column.name),
    ).toEqual(['tenant_id', 'intent_id', 'evaluation_seq']);
  });

  it('derives whether a stop is proven from its reasons instead of storing a second, divergent flag', () => {
    const proven = byName['intent_handoff_stops']?.columns.find((column) => column.name === 'proven');
    expect(proven?.generated?.type).toBe('always');
  });

  it('keeps NOT_ATTEMPTED (no adapter, nothing submitted) a delivery attempt state of its own', () => {
    const state = byName['delivery_attempts']?.columns.find((column) => column.name === 'state');
    expect(state?.notNull).toBe(true);
    expect(
      byName['delivery_attempts']?.checks.find((check) => check.name === 'communications_attempts_state_ck'),
    ).toBeDefined();
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

describe('Communications message history schema contract (#1402)', () => {
  const byName = Object.fromEntries(configs.map((config) => [config.name, config]));
  const columnsOf = (table: string) => byName[table]?.columns.map((column) => column.name) ?? [];
  const unique = (table: string) => byName[table]?.uniqueConstraints.map((constraint) => constraint.getName());

  it('enforces Tenant isolation on every history table', () => {
    for (const name of [
      'provider_observations',
      'provider_observation_conflicts',
      'attempt_retry_links',
      'intent_resend_links',
    ]) {
      expect(byName[name]?.enableRLS).toBe(true);
      expect(byName[name]?.policies).toHaveLength(4);
      expect(byName[name]?.columns.some((column) => column.name === 'tenant_id' && column.notNull)).toBe(true);
    }
  });

  it('identifies an observation by (Tenant, attempt, provider, provider observation key, evidence kind): one key may carry an acceptance and a bounce', () => {
    expect(
      byName['provider_observations']?.uniqueConstraints
        .find((constraint) => constraint.getName() === 'communications_observations_provider_identity_uk')
        ?.columns.map((column) => column.name),
    ).toEqual(['tenant_id', 'attempt_id', 'provider_key', 'observation_key', 'kind']);
  });

  it('keeps a conflicting re-delivery as an append-only trace with safe fields only, once per content', () => {
    expect(columnsOf('provider_observation_conflicts').toSorted()).toEqual([
      'attempt_id',
      'conflict_id',
      'content_fingerprint',
      'intent_id',
      'kind',
      'observation_id',
      'observation_key',
      'observed_at',
      'provider_key',
      'recorded_at',
      'recorded_seq',
      'tenant_id',
    ]);
    expect(
      byName['provider_observation_conflicts']?.uniqueConstraints
        .find((constraint) => constraint.getName() === 'communications_observation_conflicts_content_uk')
        ?.columns.map((column) => column.name),
    ).toEqual(['tenant_id', 'observation_id', 'content_fingerprint']);
    expect(byName['provider_observation_conflicts']?.checks.map((check) => check.name)).toEqual(
      expect.arrayContaining([
        'communications_observation_conflicts_kind_ck',
        'communications_observation_conflicts_keys_ck',
        'communications_observation_conflicts_fingerprint_ck',
      ]),
    );
    expect(
      byName['provider_observation_conflicts']?.foreignKeys.map((key) => [
        key.getName(),
        key.reference().columns.map((column) => column.name),
      ]),
    ).toEqual(
      expect.arrayContaining([
        ['communications_observation_conflicts_attempt_fk', ['tenant_id', 'intent_id', 'attempt_id']],
        ['communications_observation_conflicts_observation_fk', ['tenant_id', 'observation_id']],
      ]),
    );
  });

  it('binds an observation to its attempt AND its intent by one composite key', () => {
    expect(unique('delivery_attempts')).toContain('communications_attempts_intent_identity_uk');
    const foreignKey = byName['provider_observations']?.foreignKeys.find(
      (key) => key.getName() === 'communications_observations_attempt_fk',
    );
    expect(foreignKey?.reference().columns.map((column) => column.name)).toEqual([
      'tenant_id',
      'intent_id',
      'attempt_id',
    ]);
    expect(foreignKey?.reference().foreignColumns.map((column) => column.name)).toEqual([
      'tenant_id',
      'intent_id',
      'attempt_id',
    ]);
  });

  it("gives the timeline an explicit, owner-side order: the provider claim and this owner's own time and sequence", () => {
    expect(columnsOf('provider_observations')).toEqual(
      expect.arrayContaining(['observed_at', 'recorded_at', 'recorded_seq']),
    );
    const sequence = byName['provider_observations']?.columns.find((column) => column.name === 'recorded_seq');
    expect(sequence?.generatedIdentity?.type).toBe('always');
  });

  it('closes the evidence of an observation: no payload, address, markup or secret column, and checked keys and evidence', () => {
    expect(columnsOf('provider_observations').toSorted()).toEqual([
      'attempt_id',
      'evidence',
      'intent_id',
      'kind',
      'observation_id',
      'observation_key',
      'observed_at',
      'provider_key',
      'provider_ref',
      'recorded_at',
      'recorded_seq',
      'tenant_id',
    ]);
    expect(byName['provider_observations']?.checks.map((check) => check.name)).toEqual(
      expect.arrayContaining([
        'communications_observations_kind_ck',
        'communications_observations_keys_ck',
        'communications_observations_evidence_ck',
        'communications_observations_basis_ck',
      ]),
    );
  });

  it('links a Technical Retry to an attempt of the SAME intent and an Explicit Resend to exactly one original', () => {
    const retry = byName['attempt_retry_links']?.foreignKeys.map((key) => [
      key.getName(),
      key.reference().columns.map((column) => column.name),
    ]);
    expect(retry).toEqual(
      expect.arrayContaining([
        ['communications_retry_links_attempt_fk', ['tenant_id', 'intent_id', 'attempt_id']],
        ['communications_retry_links_previous_fk', ['tenant_id', 'intent_id', 'previous_attempt_id']],
      ]),
    );
    expect(unique('intent_resend_links')).toContain('communications_resend_links_resend_uk');
    expect(columnsOf('intent_resend_links').toSorted()).toEqual([
      'linked_at',
      'original_intent_id',
      'reason_code',
      'resend_intent_id',
      'tenant_id',
    ]);
  });

  it('carries no pin on an attempt or a link: recipient, language and template live on the immutable intent only', () => {
    for (const table of ['delivery_attempts', 'attempt_retry_links']) {
      expect(columnsOf(table).filter((name) => /recipient|language|template|endpoint|address/u.test(name))).toEqual([]);
    }
  });
});
