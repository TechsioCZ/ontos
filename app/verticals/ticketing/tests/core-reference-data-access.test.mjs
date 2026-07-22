import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { registerCoreReferenceProvider } from '../../../packages/core-runtime/src/core-reference.ts';
import { runDataAccess } from '../../../packages/core-runtime/src/core-sdk.ts';
import { sqlClient } from '../../../packages/core-runtime/src/db/client.ts';
import { ticketingCoreReferenceProvider } from '../src/core-reference-provider.ts';
import { coreReferenceDataAccessRegistration } from '../src/data-access/core-reference.ts';

after(() => sqlClient.end({ timeout: 1 }));

const operationContextResolver = (operationContext) => () => ({
  _tag: 'Success',
  operationContext,
});

const executeReference = (operationContext, payload) =>
  runDataAccess({
    options: { operationContextResolver: operationContextResolver(operationContext) },
    payload,
    registration: coreReferenceDataAccessRegistration,
    resultCount: (response) => (response.operation === 'discover' ? response.references.length : 1),
    transport: { headers: new Headers() },
  });

test('the governed Core Reference seam exposes the registered Ticketing provider lifecycle', async () => {
  const suffix = `${Date.now()}-${randomUUID()}`;
  const [tenant] = await sqlClient`
    insert into core.tenants (name, slug, default_locale, status)
    values ('Reference tenant', ${`reference-${suffix}`}, 'en-GB', 'active')
    returning tenant_id
  `;
  const [legalEntity] = await sqlClient`
    insert into core.legal_entities (
      tenant_id, legal_name, registration_country, registration_number, status
    ) values (
      ${tenant.tenant_id}, 'Reference legal entity', 'CZ', ${`reference-${suffix}`}, 'active'
    ) returning legal_entity_id
  `;
  const [principal] = await sqlClient`
    insert into core.principals (tenant_id, display_name, kind, status)
    values (${tenant.tenant_id}, 'Reference reader', 'human', 'active')
    returning principal_id
  `;
  await sqlClient`
    insert into core.tenant_module_states (tenant_id, module_key, state)
    values (${tenant.tenant_id}, 'ticketing', 'active')
  `;
  const [collection] = await sqlClient`
    insert into ticketing.task_collections (locale, tenant_id)
    values ('en-GB', ${tenant.tenant_id})
    returning collection_id
  `;
  const [task] = await sqlClient`
    insert into ticketing.tasks (
      collection_id,
      created_by_principal_id,
      last_edited_by_principal_id,
      tenant_id,
      title
    ) values (
      ${collection.collection_id},
      ${principal.principal_id},
      ${principal.principal_id},
      ${tenant.tenant_id},
      'Reference target'
    ) returning core_reference_token, task_id
  `;
  const operationContext = {
    legalEntityId: legalEntity.legal_entity_id,
    principalId: principal.principal_id,
    tenantId: tenant.tenant_id,
  };
  const unregisterProvider = registerCoreReferenceProvider({
    ...ticketingCoreReferenceProvider,
    authorizeOpen: () => Promise.resolve(false),
  });

  const discovered = await executeReference(operationContext, {
    operation: 'discover',
    query: 'reference',
  });
  assert.equal(discovered._tag, 'OperationSucceeded', JSON.stringify(discovered));
  assert.deepEqual(discovered.response.references, [
    {
      entityId: task.task_id,
      entityType: 'task',
      label: 'Reference target',
      ownerModuleKey: 'ticketing',
      targetTenantId: tenant.tenant_id,
      token: task.core_reference_token,
    },
  ]);

  const inserted = await executeReference(operationContext, {
    kind: 'relation',
    operation: 'insert',
    source: {
      type: 'deepLink',
      value: `https://ontos.example/ticketing/core-references/${task.core_reference_token}`,
    },
  });
  assert.equal(inserted._tag, 'OperationSucceeded', JSON.stringify(inserted));
  assert.equal(inserted.response.result._tag, 'CoreReferenceInserted');
  const { reference } = inserted.response.result;

  const forged = await executeReference(operationContext, {
    kind: 'relation',
    operation: 'insert',
    source: { type: 'rawEntityId', value: task.task_id },
  });
  assert.deepEqual(forged.response.result, {
    _tag: 'CoreReferenceRejected',
    code: 'invalid_source',
  });

  await sqlClient`
    update ticketing.tasks
    set title = 'Renamed target'
    where task_id = ${task.task_id}
  `;
  const renamed = await executeReference(operationContext, {
    operation: 'resolve',
    reference,
  });
  assert.equal(renamed.response.result._tag, 'CoreReferenceActive');
  assert.equal(renamed.response.result.reference.lastResolvedLabel, 'Renamed target');

  await sqlClient`
    update ticketing.tasks
    set retention_state = 'soft_deleted'
    where task_id = ${task.task_id}
  `;
  const deleted = await executeReference(operationContext, {
    operation: 'resolve',
    reference: renamed.response.result.reference,
  });
  assert.deepEqual(deleted.response.result, {
    _tag: 'CoreReferenceFallback',
    reference: renamed.response.result.reference,
  });

  await sqlClient`
    update ticketing.tasks
    set retention_state = 'active'
    where task_id = ${task.task_id}
  `;
  const restored = await executeReference(operationContext, {
    operation: 'resolve',
    reference: renamed.response.result.reference,
  });
  assert.equal(restored.response.result._tag, 'CoreReferenceActive');

  const deniedOpen = await executeReference(operationContext, {
    operation: 'open',
    reference: renamed.response.result.reference,
  });
  assert.deepEqual(deniedOpen.response.result, { _tag: 'CoreReferenceOpenDenied' });
  unregisterProvider();
});
