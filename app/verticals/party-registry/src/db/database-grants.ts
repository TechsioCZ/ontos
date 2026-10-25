import { PARTY_REGISTRY_REQUEST_IDENTITY, TRUST_ROUTINES } from '@app/core-runtime';
import type { DatabaseRoleGrants } from '@app/core-runtime';

/**
 * Least-privilege grants for the two Party Registry database identities. The bootstrap grants exactly
 * these privileges, and the verifiers and the trust audit compare the live catalog against them.
 * Every reason names the Core module or Party service that issues the statement.
 */

const PARTY_TABLES = [
  'counterparties',
  'counterparty_admin_read_models',
  'counterparty_role_admin_read_models',
  'counterparty_role_periods',
  'duplicate_candidate_case_parties',
  'duplicate_candidate_cases',
  'parties',
  'party_aliases',
  'party_contact_point_purposes',
  'party_contact_points',
  'party_corrections',
  'party_fact_assertions',
  'party_identifier_claims',
  'party_match_decisions',
  'party_merges',
  'party_official_identifiers',
  'party_relationships',
  'privacy_measure_executions',
] as const;

/**
 * SECURITY DEFINER routine in schema contacts that deletes only expired gateway assertion redemptions.
 * The request role prunes through it and holds no DELETE on the table.
 */
export const PRUNE_EXPIRED_GATEWAY_ASSERTION_REDEMPTIONS_SIGNATURE =
  'contacts.prune_expired_gateway_assertion_redemptions(timestamp with time zone)';

const CONTACTS_PROFILE_TABLES = ['organization_engagement_profiles', 'person_engagement_profiles'] as const;

/** Party tables read by src/services/party-search-projection-source.service.ts in the outbox worker. */
export const PARTY_REGISTRY_WORKER_PARTY_TABLES = [
  'party.parties',
  'party.party_aliases',
  'party.party_contact_points',
  'party.party_official_identifiers',
  'party.counterparties',
  'party.counterparty_role_periods',
] as const;

const WORKER_SEARCH_TABLES = [
  'core.search_index_entries',
  'core.search_projection_generations',
  'core.search_projection_rebuilds',
] as const;

const WORKER_OUTBOX_TABLES = ['core.outbox_deliveries', 'core.outbox_attempts', 'core.worker_checkpoints'] as const;

export const PARTY_REGISTRY_REQUEST_DATABASE_GRANTS: DatabaseRoleGrants = {
  schemas: ['party', 'contacts', 'core', 'trust', 'public'],
  tables: [
    ...PARTY_TABLES.map((table) => ({
      table: `party.${table}`,
      privileges: ['select', 'insert', 'update', 'delete'] as const,
      reason: 'Party Registry services and Drizzle repositories own and maintain this table under gateway-scoped RLS',
    })),
    ...CONTACTS_PROFILE_TABLES.map((table) => ({
      table: `contacts.${table}`,
      privileges: ['select', 'insert', 'update', 'delete'] as const,
      reason: 'Party Registry engagement profile persistence service owns this table under gateway-scoped RLS',
    })),
    {
      table: 'contacts.gateway_assertion_redemptions',
      privileges: ['select', 'insert'],
      reason:
        'Party auth/gateway-assertion-redemption-runtime records single-use gateway assertion jti values; pruning goes through the contacts prune routine',
    },
    {
      table: 'core.tenants',
      privileges: ['select', 'update'],
      columns: { select: ['tenant_id', 'status'], update: ['tenant_id'] },
      reason:
        'Core operations/context checks tenant status; Core actions/runtime takes the tenant row lock with a no-op update',
    },
    {
      table: 'core.legal_entities',
      privileges: ['select'],
      columns: { select: ['legal_entity_id', 'tenant_id', 'status'] },
      reason: 'Core auth/legal-entity-context and operations/context check legal-entity membership and status',
    },
    {
      table: 'core.principals',
      privileges: ['select'],
      columns: { select: ['principal_id', 'tenant_id', 'kind', 'status'] },
      reason: 'Core operations/context checks the acting principal status and agent-key issuing-company boundary',
    },
    {
      table: 'core.principal_auth_bindings',
      privileges: ['select'],
      columns: {
        select: [
          'principal_auth_binding_id',
          'tenant_id',
          'principal_id',
          'authentication_namespace_id',
          'subject_type',
          'status',
          'binding_revision',
          'revoked_at',
        ],
      },
      reason: 'Core auth/principal-resolver resolves the active authentication binding of the acting principal',
    },
    {
      table: 'core.tenant_module_states',
      privileges: ['select'],
      reason: 'Core modules/module-state-gate checks that party.registry is enabled for the tenant',
    },
    {
      table: 'core.application_composition_authority',
      privileges: ['select'],
      reason: 'Core modules/application-composition-authority reads the active composition revision',
    },
    {
      table: 'core.action_invocations',
      privileges: ['select', 'insert', 'update'],
      reason: 'Core actions/repository records and completes party.registry action invocations (idempotency)',
    },
    {
      table: 'core.audit_events',
      privileges: ['select', 'insert'],
      columns: { select: ['action_invocation_id', 'event_type', 'outcome_code', 'outcome_stage'] },
      reason: 'Core actions/repository writes audit events and reads outcome columns for idempotent replay',
    },
    {
      table: 'core.data_access_events',
      privileges: ['insert'],
      reason: 'Core reads/repository and actions/collector record data access evidence for party.registry',
    },
    {
      table: 'core.domain_events',
      privileges: ['insert'],
      reason: 'Core actions/events appends party.registry domain events',
    },
    {
      table: 'core.outbox_messages',
      privileges: ['insert'],
      reason: 'Core actions/events enqueues party.registry outbox messages',
    },
    {
      table: 'core.search_index_entries',
      privileges: ['select'],
      reason: 'Core search/persistence queries party.registry search candidates for Party Search providers',
    },
  ],
  sequences: [
    {
      sequence: 'core.domain_event_tenant_sequence_no_seq',
      privileges: ['usage'],
      reason: 'Core actions/events draws the tenant sequence number for appended domain events',
    },
  ],
  routines: [
    ...TRUST_ROUTINES.flatMap(({ executableBy, signature }) =>
      executableBy.includes(PARTY_REGISTRY_REQUEST_IDENTITY.role) ? [signature] : [],
    ),
    PRUNE_EXPIRED_GATEWAY_ASSERTION_REDEMPTIONS_SIGNATURE,
  ],
  acceptedFindings: [],
};

export const PARTY_REGISTRY_WORKER_DATABASE_GRANTS: DatabaseRoleGrants = {
  schemas: ['party', 'core', 'public'],
  tables: [
    ...PARTY_REGISTRY_WORKER_PARTY_TABLES.map((table) => ({
      table,
      privileges: ['select'] as const,
      reason: 'Party search projection source service reads this table to build search documents',
    })),
    {
      table: 'core.outbox_messages',
      privileges: ['select', 'update'],
      columns: { update: ['matched_at'] },
      reason: 'Core outbox/repository matches outbox messages to deliveries',
    },
    ...WORKER_OUTBOX_TABLES.map((table) => ({
      table,
      privileges: ['select', 'insert', 'update'] as const,
      reason: 'Core outbox/repository claims, attempts and completes deliveries and advances worker checkpoints',
    })),
    ...WORKER_SEARCH_TABLES.map((table) => ({
      table,
      privileges: ['select', 'insert', 'update'] as const,
      reason: 'Core search/persistence and search/worker-snapshot maintain party.registry search projections',
    })),
    {
      table: 'core.domain_events',
      privileges: ['select', 'update'],
      columns: { update: ['domain_event_id'] },
      reason: 'Core outbox/repository reads delivered domain events and row-locks them with a no-op update',
    },
    {
      table: 'core.tenant_module_states',
      privileges: ['select', 'update'],
      columns: { update: ['tenant_module_state_id'] },
      reason: 'Core outbox/repository checks module state and row-locks it with a no-op update',
    },
    {
      table: 'core.tenants',
      privileges: ['select', 'update'],
      columns: { select: ['tenant_id', 'status'], update: ['tenant_id'] },
      reason:
        'Core outbox/repository filters claimable deliveries by tenant lifecycle status, and Core outbox/tenant-scope resolves and row-locks the delivery tenant with a no-op update',
    },
    {
      table: 'core.legal_entities',
      privileges: ['select'],
      columns: { select: ['legal_entity_id', 'tenant_id', 'status'] },
      reason: 'Core outbox/legal-entity-scope-fanout and search/worker-snapshot resolve legal-entity scope',
    },
    {
      table: 'core.action_invocations',
      privileges: ['select'],
      reason: 'Core outbox/completion-publication reads the originating action invocation',
    },
    {
      table: 'core.application_composition_authority',
      privileges: ['select'],
      reason: 'Core modules/application-composition-authority reads the active composition revision',
    },
  ],
  sequences: [],
  routines: [],
  acceptedFindings: [
    {
      code: 'runtime_role_can_forge_trusted_context',
      objects: [...PARTY_REGISTRY_WORKER_PARTY_TABLES, ...WORKER_SEARCH_TABLES],
      reason: 'Outbox worker excluded from the trusted path: no issuer artifact; multi-tenant by design',
    },
  ],
};
