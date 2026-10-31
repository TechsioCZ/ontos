import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { pgPolicy } from 'drizzle-orm/pg-core';
import type { AnyPgColumn, PgPolicy, PgTable } from 'drizzle-orm/pg-core';
import { Schema } from 'effect';

import { defineDatabaseIdentityEnrollment, SHARED_RUNTIME_IDENTITY } from './database-identity-manifest.ts';
import type { DatabaseIdentityEnrollment, DatabaseOwnerIdentityDescriptor } from './database-identity-manifest.ts';
import {
  actionInvocations,
  applicationCompositionAuthority,
  auditEvents,
  dataAccessEvents,
  domainEvents,
  legalEntities,
  outboxMessages,
  principalAuthBindings,
  principals,
  searchIndexEntries,
  searchProjectionGenerations,
  searchProjectionRebuilds,
  tenantModuleStates,
  tenants,
} from './schema.ts';

export interface CoreIdentityPolicyDescriptor {
  readonly policy: PgPolicy;
  readonly table: PgTable;
  readonly trustedLegalEntity?: true;
  readonly trustedTenant?: true;
}

const CorePolicyDefinitionInvariantError = Schema.TaggedError<Error>()('CorePolicyDefinitionInvariantError', {
  message: Schema.String,
});

const CANONICAL_MODULE_KEY_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const CANONICAL_POLICY_NAME_PATTERN = /^[a-z][a-z0-9_]*$/u;
const TRUSTED_TENANT_ID = sql`(select trust.current_tenant_id())`;
const SESSION_TENANT_ID = sql`nullif(current_setting('ontos.tenant_id', true), '')::uuid`;

/** Only canonical module keys may become SQL literals in migration policy predicates. */
const moduleKeyPolicyLiteral = (moduleKey: string, suffix: '' | '.'): SQL => {
  if (!CANONICAL_MODULE_KEY_PATTERN.test(moduleKey)) {
    throw new CorePolicyDefinitionInvariantError({ message: 'Core policy module key is not canonical' });
  }
  return sql.raw(`'${moduleKey}${suffix}'`);
};

const trustedTenantLegalEntityPredicate = (tenantColumn: AnyPgColumn, legalEntityColumn: AnyPgColumn) =>
  sql`${tenantColumn} = ${TRUSTED_TENANT_ID} and ((select trust.current_legal_entity_id()) is null or ${legalEntityColumn} is null or ${legalEntityColumn} = (select trust.current_legal_entity_id()))`;

const linkedPolicy = (
  table: PgTable,
  policy: PgPolicy,
  scope: Pick<CoreIdentityPolicyDescriptor, 'trustedLegalEntity' | 'trustedTenant'> = {},
): CoreIdentityPolicyDescriptor => {
  if (!CANONICAL_POLICY_NAME_PATTERN.test(policy.name) || policy.name.length > 63) {
    throw new CorePolicyDefinitionInvariantError({
      message: 'Core policy name is not a canonical PostgreSQL identifier',
    });
  }
  if (Array.isArray(policy.to)) {
    Object.freeze(policy.to);
  }
  return Object.freeze({ ...scope, policy: Object.freeze(policy.link(table)), table });
};

const ownerPolicies = (owner: DatabaseOwnerIdentityDescriptor): readonly CoreIdentityPolicyDescriptor[] => {
  const requestRole = owner.request.role;
  const workerRole = owner.worker.role;
  const roles = [requestRole, workerRole];
  const moduleKey = moduleKeyPolicyLiteral(owner.moduleKey, '');
  const actionKeyPrefix = moduleKeyPolicyLiteral(owner.moduleKey, '.');
  return [
    linkedPolicy(
      tenants,
      pgPolicy(`core_tenants_${owner.policyPrefix}_select`, { for: 'select', to: roles, using: sql`true` }),
    ),
    linkedPolicy(
      tenants,
      pgPolicy(`core_tenants_${owner.policyPrefix}_request_lock`, {
        for: 'update',
        to: requestRole,
        using: sql`${tenants.tenantId} = ${TRUSTED_TENANT_ID}`,
        withCheck: sql`false`,
      }),
      { trustedTenant: true },
    ),
    linkedPolicy(
      tenants,
      pgPolicy(`core_tenants_${owner.policyPrefix}_worker_lock`, {
        for: 'update',
        to: workerRole,
        using: sql`true`,
        withCheck: sql`false`,
      }),
    ),
    linkedPolicy(
      legalEntities,
      pgPolicy(`core_legal_entities_${owner.policyPrefix}_request_select`, {
        for: 'select',
        to: requestRole,
        using: sql`${legalEntities.tenantId} = ${TRUSTED_TENANT_ID}`,
      }),
      { trustedTenant: true },
    ),
    linkedPolicy(
      legalEntities,
      pgPolicy(`core_legal_entities_${owner.policyPrefix}_worker_select`, {
        for: 'select',
        to: workerRole,
        using: sql`true`,
      }),
    ),
    linkedPolicy(
      principals,
      pgPolicy(`core_principals_${owner.policyPrefix}_request_select`, {
        for: 'select',
        to: requestRole,
        using: sql`${principals.tenantId} = ${TRUSTED_TENANT_ID}`,
      }),
      { trustedTenant: true },
    ),
    linkedPolicy(
      principalAuthBindings,
      pgPolicy(`core_principal_auth_bindings_${owner.policyPrefix}_request_select`, {
        for: 'select',
        to: requestRole,
        using: sql`${principalAuthBindings.tenantId} = ${TRUSTED_TENANT_ID}`,
      }),
      { trustedTenant: true },
    ),
    linkedPolicy(
      tenantModuleStates,
      pgPolicy(`core_tenant_module_states_${owner.policyPrefix}_select`, {
        for: 'select',
        to: roles,
        using: sql`true`,
      }),
    ),
    linkedPolicy(
      tenantModuleStates,
      pgPolicy(`core_tenant_module_states_${owner.policyPrefix}_worker_lock`, {
        for: 'update',
        to: workerRole,
        using: sql`true`,
        withCheck: sql`false`,
      }),
    ),
    linkedPolicy(
      actionInvocations,
      pgPolicy(`core_action_invocations_${owner.policyPrefix}_request_select`, {
        for: 'select',
        to: requestRole,
        using: sql`${trustedTenantLegalEntityPredicate(actionInvocations.tenantId, actionInvocations.legalEntityId)} and starts_with(${actionInvocations.actionKey}, ${actionKeyPrefix})`,
      }),
      { trustedLegalEntity: true, trustedTenant: true },
    ),
    linkedPolicy(
      actionInvocations,
      pgPolicy(`core_action_invocations_${owner.policyPrefix}_request_insert`, {
        for: 'insert',
        to: requestRole,
        withCheck: sql`${trustedTenantLegalEntityPredicate(actionInvocations.tenantId, actionInvocations.legalEntityId)} and starts_with(${actionInvocations.actionKey}, ${actionKeyPrefix})`,
      }),
      { trustedLegalEntity: true, trustedTenant: true },
    ),
    linkedPolicy(
      actionInvocations,
      pgPolicy(`core_action_invocations_${owner.policyPrefix}_request_update`, {
        for: 'update',
        to: requestRole,
        using: sql`${trustedTenantLegalEntityPredicate(actionInvocations.tenantId, actionInvocations.legalEntityId)} and starts_with(${actionInvocations.actionKey}, ${actionKeyPrefix})`,
        withCheck: sql`${trustedTenantLegalEntityPredicate(actionInvocations.tenantId, actionInvocations.legalEntityId)} and starts_with(${actionInvocations.actionKey}, ${actionKeyPrefix})`,
      }),
      { trustedLegalEntity: true, trustedTenant: true },
    ),
    linkedPolicy(
      actionInvocations,
      pgPolicy(`core_action_invocations_${owner.policyPrefix}_worker_select`, {
        for: 'select',
        to: workerRole,
        using: sql`true`,
      }),
    ),
    linkedPolicy(
      auditEvents,
      pgPolicy(`core_audit_events_${owner.policyPrefix}_request_select`, {
        for: 'select',
        to: requestRole,
        using: sql`${trustedTenantLegalEntityPredicate(auditEvents.tenantId, auditEvents.legalEntityId)} and exists (select 1 from core.action_invocations as i where i.action_invocation_id = ${auditEvents.actionInvocationId} and starts_with(i.action_key, ${actionKeyPrefix}))`,
      }),
      { trustedLegalEntity: true, trustedTenant: true },
    ),
    linkedPolicy(
      auditEvents,
      pgPolicy(`core_audit_events_${owner.policyPrefix}_request_insert`, {
        for: 'insert',
        to: requestRole,
        withCheck: sql`${trustedTenantLegalEntityPredicate(auditEvents.tenantId, auditEvents.legalEntityId)} and exists (select 1 from core.action_invocations as i where i.action_invocation_id = ${auditEvents.actionInvocationId} and starts_with(i.action_key, ${actionKeyPrefix}))`,
      }),
      { trustedLegalEntity: true, trustedTenant: true },
    ),
    linkedPolicy(
      dataAccessEvents,
      pgPolicy(`core_data_access_events_${owner.policyPrefix}_request_insert`, {
        for: 'insert',
        to: requestRole,
        withCheck: sql`${trustedTenantLegalEntityPredicate(dataAccessEvents.tenantId, dataAccessEvents.legalEntityId)} and ${dataAccessEvents.servingModuleKey} = ${moduleKey}`,
      }),
      { trustedLegalEntity: true, trustedTenant: true },
    ),
    linkedPolicy(
      domainEvents,
      pgPolicy(`core_domain_events_${owner.policyPrefix}_request_insert`, {
        for: 'insert',
        to: requestRole,
        withCheck: sql`${trustedTenantLegalEntityPredicate(domainEvents.tenantId, domainEvents.legalEntityId)} and ${domainEvents.producerModuleKey} = ${moduleKey}`,
      }),
      { trustedLegalEntity: true, trustedTenant: true },
    ),
    linkedPolicy(
      domainEvents,
      pgPolicy(`core_domain_events_${owner.policyPrefix}_worker_select`, {
        for: 'select',
        to: workerRole,
        using: sql`true`,
      }),
    ),
    linkedPolicy(
      domainEvents,
      pgPolicy(`core_domain_events_${owner.policyPrefix}_worker_lock`, {
        for: 'update',
        to: workerRole,
        using: sql`true`,
        withCheck: sql`false`,
      }),
    ),
    linkedPolicy(
      outboxMessages,
      pgPolicy(`core_outbox_messages_${owner.policyPrefix}_request_insert`, {
        for: 'insert',
        to: requestRole,
        withCheck: sql`${outboxMessages.tenantId} = ${TRUSTED_TENANT_ID} and ${outboxMessages.producerModuleKey} = ${moduleKey}`,
      }),
      { trustedTenant: true },
    ),
    linkedPolicy(
      outboxMessages,
      pgPolicy(`core_outbox_messages_${owner.policyPrefix}_worker_select`, {
        for: 'select',
        to: workerRole,
        using: sql`true`,
      }),
    ),
    linkedPolicy(
      outboxMessages,
      pgPolicy(`core_outbox_messages_${owner.policyPrefix}_worker_update`, {
        for: 'update',
        to: workerRole,
        using: sql`true`,
        withCheck: sql`true`,
      }),
    ),
    linkedPolicy(
      searchIndexEntries,
      pgPolicy(`core_search_index_entries_${owner.policyPrefix}_request_select`, {
        for: 'select',
        to: requestRole,
        using: sql`${trustedTenantLegalEntityPredicate(searchIndexEntries.tenantId, searchIndexEntries.legalEntityId)} and ${searchIndexEntries.sourceModuleKey} = ${moduleKey}`,
      }),
      { trustedLegalEntity: true, trustedTenant: true },
    ),
  ];
};

const workerSearchPolicies = (
  owner: DatabaseOwnerIdentityDescriptor,
  table: typeof searchIndexEntries | typeof searchProjectionGenerations | typeof searchProjectionRebuilds,
  prefix: string,
): readonly CoreIdentityPolicyDescriptor[] => {
  const predicate = sql`${table.tenantId} = ${SESSION_TENANT_ID} and ${table.sourceModuleKey} = ${moduleKeyPolicyLiteral(owner.moduleKey, '')}`;
  return [
    linkedPolicy(
      table,
      pgPolicy(`${prefix}_${owner.policyPrefix}_worker_select`, {
        for: 'select',
        to: owner.worker.role,
        using: predicate,
      }),
    ),
    linkedPolicy(
      table,
      pgPolicy(`${prefix}_${owner.policyPrefix}_worker_insert`, {
        for: 'insert',
        to: owner.worker.role,
        withCheck: predicate,
      }),
    ),
    linkedPolicy(
      table,
      pgPolicy(`${prefix}_${owner.policyPrefix}_worker_update`, {
        for: 'update',
        to: owner.worker.role,
        using: predicate,
        withCheck: predicate,
      }),
    ),
  ];
};

const sharedSearchPolicies = (
  enrollment: DatabaseIdentityEnrollment,
  table: typeof searchIndexEntries | typeof searchProjectionGenerations | typeof searchProjectionRebuilds,
  prefix: string,
  operations: readonly ('select' | 'insert' | 'update' | 'delete')[],
): readonly CoreIdentityPolicyDescriptor[] => {
  const exclusions = enrollment.dedicatedModuleKeys.map(
    (key) => sql`${table.sourceModuleKey} <> ${moduleKeyPolicyLiteral(key, '')}`,
  );
  const excludedModules = sql.join(exclusions, sql` and `);
  const exclusionPredicate = exclusions.length === 0 ? sql`` : sql` and ${excludedModules}`;
  const predicate = sql`${table.tenantId} = ${SESSION_TENANT_ID}${exclusionPredicate}`;
  return operations.map((operation) =>
    linkedPolicy(
      table,
      pgPolicy(`${prefix}_tenant_${operation}`, {
        for: operation,
        to: SHARED_RUNTIME_IDENTITY.role,
        using: operation === 'insert' ? undefined : predicate,
        withCheck: operation === 'select' || operation === 'delete' ? undefined : predicate,
      }),
    ),
  );
};

/** Builds migration-only policies; neither enrollment nor the stable runtime tables are mutated. */
export const makeCoreIdentityPolicies = (
  enrollment: DatabaseIdentityEnrollment,
): readonly CoreIdentityPolicyDescriptor[] => {
  const validated = defineDatabaseIdentityEnrollment(enrollment.owners);
  if (
    enrollment.dedicatedModuleKeys.length !== validated.dedicatedModuleKeys.length ||
    enrollment.dedicatedModuleKeys.some((key, index) => key !== validated.dedicatedModuleKeys[index])
  ) {
    throw new CorePolicyDefinitionInvariantError({
      message: 'Core policy enrollment has inconsistent dedicated module keys',
    });
  }
  const descriptors = [
    linkedPolicy(
      applicationCompositionAuthority,
      pgPolicy('core_application_composition_authority_select', {
        for: 'select',
        to: [
          SHARED_RUNTIME_IDENTITY.role,
          ...validated.owners.flatMap((owner) => [owner.request.role, owner.worker.role]),
        ],
        using: sql`true`,
      }),
    ),
    ...sharedSearchPolicies(validated, searchIndexEntries, 'core_search_index_entries', [
      'select',
      'insert',
      'update',
      'delete',
    ]),
    ...sharedSearchPolicies(validated, searchProjectionGenerations, 'core_search_projection_generations', [
      'select',
      'insert',
      'update',
    ]),
    ...sharedSearchPolicies(validated, searchProjectionRebuilds, 'core_search_projection_rebuilds', [
      'select',
      'insert',
      'update',
    ]),
    ...validated.owners.flatMap((owner) => [
      ...ownerPolicies(owner),
      ...workerSearchPolicies(owner, searchIndexEntries, 'core_search_index_entries'),
      ...workerSearchPolicies(owner, searchProjectionGenerations, 'core_search_projection_generations'),
      ...workerSearchPolicies(owner, searchProjectionRebuilds, 'core_search_projection_rebuilds'),
    ]),
  ];
  if (new Set(descriptors.map(({ policy }) => policy.name)).size !== descriptors.length) {
    throw new CorePolicyDefinitionInvariantError({ message: 'Core policy enrollment contains duplicate policy names' });
  }
  return Object.freeze(descriptors);
};
