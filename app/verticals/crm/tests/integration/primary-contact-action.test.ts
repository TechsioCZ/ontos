/* eslint-disable max-lines, node/no-process-env -- The live Action scenario verifies one complete invocation lifecycle and configures its isolated SpiceDB permission fixture explicitly. */
import assert from 'node:assert/strict';
// @effect-diagnostics asyncFunction:off processEnv:off
import test from 'node:test';
import { ActionRuntime, ActionRuntimeLive, CorePersistenceLive } from '@app/core-runtime';
import { v1 } from '@authzed/authzed-node';
import { Effect, Exit, Layer } from 'effect';
import { Client } from 'pg';
import { changeCustomerPrimaryContactAction } from '../../src/actions/change-customer-primary-contact.action.ts';
import '../../src/contacts/contact-actions.runtime.ts';
import { loadCrmDatabaseConnectionPair } from '../../src/db/config.ts';

const tenantId = '50000000-0000-4000-8000-000000000001';
const legalEntityId = '55000000-0000-4000-8000-000000000001';
const deniedLegalEntityId = '55000000-0000-4000-8000-000000000099';
const principalId = '60000000-0000-4000-8000-000000000001';
const authBindingId = '65000000-0000-4000-8000-000000000001';
const customerId = '89000000-0000-4000-8000-000000000001';
const contact1 = '8a000000-0000-4000-8000-000000000001';
const contact2 = '8a000000-0000-4000-8000-000000000002';

const principal = {
  authBindingId,
  authContextRef: 'better-auth-session:primary-contact-action-test',
  authMethod: 'session' as const,
  legalEntityId,
  principalId,
  tenantId,
};
const payload = {
  customerId,
  expectedCurrentPrimaryContactId: null,
  expectedCurrentPrimaryContactVersion: null,
  expectedCustomerVersion: 1,
  expectedSelectedContactVersion: 1,
  selectedContactId: contact1,
} as const;
const transport = (idempotencyKey: string) => ({
  correlationId: `primary-contact-action-${idempotencyKey}`,
  idempotencyKey,
  targetModuleKey: 'crm.core',
  targetResourceId: customerId,
  targetResourceType: 'crm.core.customer',
});

test('commits and replays the live primary Contact Action with atomic evidence', async () => {
  const configuration = await Effect.runPromise(loadCrmDatabaseConnectionPair());
  const admin = new Client({ connectionString: configuration.admin.connectionString });
  const spiceDbEndpoint = process.env['SPICEDB_ENDPOINT'];
  const spiceDbPreSharedKey = process.env['SPICEDB_PRESHARED_KEY'];
  assert.ok(spiceDbEndpoint !== undefined);
  assert.ok(spiceDbPreSharedKey !== undefined);
  const spiceDbClient = v1.NewClient(
    spiceDbPreSharedKey,
    spiceDbEndpoint,
    process.env['SPICEDB_INSECURE'] === 'true'
      ? v1.ClientSecurity.INSECURE_LOCALHOST_ALLOWED
      : v1.ClientSecurity.SECURE,
  );
  const actionObjectId = `ak_${Buffer.from(
    'crm.core.change-customer-primary-contact',
    'utf-8',
  ).toString('base64url')}`;
  const actionRestriction = v1.Relationship.create({
    relation: 'restriction',
    resource: v1.ObjectReference.create({ objectId: actionObjectId, objectType: 'action' }),
    subject: v1.SubjectReference.create({
      object: v1.ObjectReference.create({ objectId: actionObjectId, objectType: 'action' }),
    }),
  });
  await admin.connect();
  const cleanup = async () => {
    await admin.query('delete from core.outbox_messages where tenant_id = $1', [tenantId]);
    await admin.query('delete from core.domain_events where tenant_id = $1', [tenantId]);
    await admin.query('delete from core.data_access_events where tenant_id = $1', [tenantId]);
    await admin.query('delete from core.audit_events where tenant_id = $1', [tenantId]);
    await admin.query('delete from core.tenant_module_state_changes where tenant_id = $1', [
      tenantId,
    ]);
    await admin.query('delete from core.tenant_module_states where tenant_id = $1', [tenantId]);
    await admin.query('delete from core.action_invocations where tenant_id = $1', [tenantId]);
    await admin.query('delete from crm.contacts where tenant_id = $1', [tenantId]);
    await admin.query('delete from crm.customers where tenant_id = $1', [tenantId]);
    await admin.query('delete from core.principal_auth_bindings where tenant_id = $1', [tenantId]);
    await admin.query('delete from core.principals where tenant_id = $1', [tenantId]);
    await admin.query('delete from core.legal_entities where tenant_id = $1', [tenantId]);
    await admin.query('delete from core.tenants where tenant_id = $1', [tenantId]);
  };

  try {
    await cleanup();
    await admin.query(
      `insert into core.tenants (tenant_id, slug, name, status, default_locale)
       values ($1, 'primary-contact-action-test', 'Primary Contact Action Test', 'active', 'en')`,
      [tenantId],
    );
    await admin.query(
      `insert into core.legal_entities
        (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status)
       values
        ($1, $2, 'Primary Contact Action Test', 'CZ', 'PRIMARY-CONTACT-ACTION', 'active'),
        ($3, $2, 'Denied Context', 'CZ', 'PRIMARY-CONTACT-DENIED', 'active')`,
      [legalEntityId, tenantId, deniedLegalEntityId],
    );
    await admin.query(
      `insert into core.principals (principal_id, tenant_id, kind, display_name, status)
       values ($1, $2, 'human', 'Primary Contact Action Test', 'active')`,
      [principalId, tenantId],
    );
    await admin.query(
      `insert into core.principal_auth_bindings
        (principal_auth_binding_id, tenant_id, principal_id, provider, subject_type, provider_subject_id, status)
       values ($1, $2, $3, 'better_auth', 'user', 'primary-contact-action-test', 'active')`,
      [authBindingId, tenantId, principalId],
    );
    await admin.query(
      `insert into core.tenant_module_states (tenant_id, module_key, state)
       values ($1, 'crm.core', 'active')`,
      [tenantId],
    );
    await admin.query(
      `insert into crm.customers (customer_id, tenant_id, name)
       values ($1, $2, 'Action customer')`,
      [customerId, tenantId],
    );
    await admin.query(
      `insert into crm.contacts (contact_id, tenant_id, customer_id, first_name)
       values ($1, $3, $4, 'One'), ($2, $3, $4, 'Two')`,
      [contact1, contact2, tenantId, customerId],
    );
    await spiceDbClient.promises.writeRelationships(
      v1.WriteRelationshipsRequest.create({
        updates: [
          v1.RelationshipUpdate.create({
            operation: v1.RelationshipUpdate_Operation.TOUCH,
            relationship: actionRestriction,
          }),
        ],
      }),
    );

    const actionRuntimeLive = ActionRuntimeLive.pipe(Layer.provide(CorePersistenceLive));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* runPrimaryContactActionLifecycle() {
          const runtime = yield* ActionRuntime;
          const denied = yield* Effect.exit(
            runtime.runAction({
              payload,
              principal,
              registration: changeCustomerPrimaryContactAction,
              transport: transport('primary-contact-live-denied'),
            }),
          );
          assert.equal(Exit.isFailure(denied), true);
          assert.match(JSON.stringify(denied), /ActionPermissionDenied/u);
          const denialState = yield* Effect.promise(async () => {
            const invocationQuery = await admin.query<{
              readonly action_invocation_id: string;
              readonly status: string;
            }>(
              `select action_invocation_id, status from core.action_invocations
                   where tenant_id = $1 and idempotency_key = $2`,
              [tenantId, 'primary-contact-live-denied'],
            );
            const [invocation] = invocationQuery.rows;
            assert.ok(invocation !== undefined);
            const audit = await admin.query<{ readonly count: string }>(
              'select count(*)::text as count from core.audit_events where action_invocation_id = $1',
              [invocation.action_invocation_id],
            );
            const dataAccess = await admin.query<{ readonly count: string }>(
              'select count(*)::text as count from core.data_access_events where action_invocation_id = $1',
              [invocation.action_invocation_id],
            );
            const domain = await admin.query<{ readonly count: string }>(
              'select count(*)::text as count from core.domain_events where action_invocation_id = $1',
              [invocation.action_invocation_id],
            );
            const primary = await admin.query<{ readonly count: string }>(
              'select count(*)::text as count from crm.contacts where customer_id = $1 and is_primary_contact',
              [customerId],
            );
            const evidence = [audit, dataAccess, domain, primary];
            return { evidence, status: invocation.status };
          });
          assert.equal(denialState.status, 'rejected');
          assert.deepEqual(
            denialState.evidence.map(({ rows }) => rows[0]?.count),
            ['1', '0', '0', '0'],
          );

          yield* Effect.promise(() =>
            spiceDbClient.promises.deleteRelationships(
              v1.DeleteRelationshipsRequest.create({
                relationshipFilter: v1.RelationshipFilter.create({
                  optionalResourceId: actionObjectId,
                  resourceType: 'action',
                }),
              }),
            ),
          );
          const selectedContextDenied = yield* Effect.exit(
            runtime.runAction({
              payload,
              principal: { ...principal, legalEntityId: deniedLegalEntityId },
              registration: changeCustomerPrimaryContactAction,
              transport: transport('primary-contact-live-context-denied'),
            }),
          );
          assert.equal(Exit.isFailure(selectedContextDenied), true);
          assert.match(JSON.stringify(selectedContextDenied), /OperationContextDenied/u);
          const contextDeniedInvocation = yield* Effect.promise(() =>
            admin.query<{ readonly count: string }>(
              'select count(*)::text as count from core.action_invocations where tenant_id = $1 and idempotency_key = $2',
              [tenantId, 'primary-contact-live-context-denied'],
            ),
          );
          assert.equal(contextDeniedInvocation.rows[0]?.count, '0');

          const first = yield* runtime.runAction({
            payload,
            principal,
            registration: changeCustomerPrimaryContactAction,
            transport: transport('primary-contact-live-success'),
          });
          assert.equal(first.customerVersion, 2);
          assert.equal(first.primaryContactId, contact1);
          assert.equal(first.primaryContactVersion, 2);

          const [invocation] = (yield* Effect.promise(() =>
            admin.query<{
              readonly action_invocation_id: string;
              readonly status: string;
            }>(
              `select action_invocation_id, status
                 from core.action_invocations
                 where tenant_id = $1 and action_key = $2 and idempotency_key = $3`,
              [
                tenantId,
                'crm.core.change-customer-primary-contact',
                'primary-contact-live-success',
              ],
            ),
          )).rows;
          assert.ok(invocation !== undefined);
          assert.equal(invocation.status, 'succeeded');

          const evidence = yield* Effect.promise(async () => {
            const audit = await admin.query<{ readonly count: string }>(
              'select count(*)::text as count from core.audit_events where action_invocation_id = $1',
              [invocation.action_invocation_id],
            );
            const dataAccess = await admin.query<{ readonly count: string }>(
              'select count(*)::text as count from core.data_access_events where action_invocation_id = $1',
              [invocation.action_invocation_id],
            );
            const domain = await admin.query<{
              readonly event_type: string;
              readonly payload_json: {
                readonly customerId: string;
                readonly previousPrimaryContactId: null | string;
                readonly primaryContactId: null | string;
              };
              readonly subject_resource_id: string;
            }>(
              `select event_type, payload_json, subject_resource_id
                 from core.domain_events where action_invocation_id = $1`,
              [invocation.action_invocation_id],
            );
            return [audit, dataAccess, domain] as const;
          });
          assert.equal(evidence[0].rows[0]?.count, '1');
          assert.equal(evidence[1].rows[0]?.count, '3');
          assert.deepEqual(evidence[2].rows, [
            {
              event_type: 'crm.core.customer.primary-contact-changed',
              payload_json: {
                customerId,
                previousPrimaryContactId: null,
                primaryContactId: contact1,
              },
              subject_resource_id: customerId,
            },
          ]);

          const replay = yield* Effect.exit(
            runtime.runAction({
              payload,
              principal,
              registration: changeCustomerPrimaryContactAction,
              transport: transport('primary-contact-live-success'),
            }),
          );
          assert.equal(Exit.isFailure(replay), true);
          assert.match(JSON.stringify(replay), /ActionAlreadyCommitted/u);

          const hashConflict = yield* Effect.exit(
            runtime.runAction({
              payload: {
                ...payload,
                expectedSelectedContactVersion: 1,
                selectedContactId: contact2,
              },
              principal,
              registration: changeCustomerPrimaryContactAction,
              transport: transport('primary-contact-live-success'),
            }),
          );
          assert.equal(Exit.isFailure(hashConflict), true);
          assert.match(JSON.stringify(hashConflict), /ActionRequestHashConflict/u);

          const afterReplay = yield* Effect.promise(async () => {
            const audit = await admin.query<{ readonly count: string }>(
              'select count(*)::text as count from core.audit_events where action_invocation_id = $1',
              [invocation.action_invocation_id],
            );
            const dataAccess = await admin.query<{ readonly count: string }>(
              'select count(*)::text as count from core.data_access_events where action_invocation_id = $1',
              [invocation.action_invocation_id],
            );
            const domain = await admin.query<{ readonly count: string }>(
              'select count(*)::text as count from core.domain_events where action_invocation_id = $1',
              [invocation.action_invocation_id],
            );
            const primary = await admin.query<{
              readonly contact_id: string;
              readonly version: number;
            }>(
              'select contact_id, version from crm.contacts where customer_id = $1 and is_primary_contact',
              [customerId],
            );
            return { audit, dataAccess, domain, primary };
          });
          assert.deepEqual(
            [afterReplay.audit, afterReplay.dataAccess, afterReplay.domain].map(
              ({ rows }) => rows[0]?.count,
            ),
            ['1', '3', '1'],
          );
          assert.deepEqual(afterReplay.primary.rows, [{ contact_id: contact1, version: 2 }]);

          const beforeFlushFailure = yield* Effect.promise(async () => {
            const customer = await admin.query<{ readonly version: number }>(
              'select version from crm.customers where customer_id = $1',
              [customerId],
            );
            const contacts = await admin.query<{
              readonly contact_id: string;
              readonly is_primary_contact: boolean;
              readonly version: number;
            }>(
              'select contact_id, is_primary_contact, version from crm.contacts where customer_id = $1 order by contact_id',
              [customerId],
            );
            const audit = await admin.query<{ readonly count: string }>(
              'select count(*)::text as count from core.audit_events where tenant_id = $1',
              [tenantId],
            );
            const dataAccess = await admin.query<{ readonly count: string }>(
              'select count(*)::text as count from core.data_access_events where tenant_id = $1',
              [tenantId],
            );
            const domain = await admin.query<{ readonly count: string }>(
              'select count(*)::text as count from core.domain_events where tenant_id = $1',
              [tenantId],
            );
            const counts = [audit, dataAccess, domain];
            return { contacts: contacts.rows, counts, customer: customer.rows };
          });
          yield* Effect.promise(() =>
            admin.query(`alter table core.domain_events
              add constraint core_domain_events_reject_primary_contact_test_ck
              check (event_type <> 'crm.core.customer.primary-contact-changed') not valid`),
          );
          const flushFailure = yield* Effect.exit(
            runtime.runAction({
              payload: {
                ...payload,
                expectedCurrentPrimaryContactId: contact1,
                expectedCurrentPrimaryContactVersion: 2,
                expectedCustomerVersion: 2,
                expectedSelectedContactVersion: 1,
                selectedContactId: contact2,
              },
              principal,
              registration: changeCustomerPrimaryContactAction,
              transport: transport('primary-contact-live-flush-failure'),
            }),
          );
          yield* Effect.promise(() =>
            admin.query(
              'alter table core.domain_events drop constraint core_domain_events_reject_primary_contact_test_ck',
            ),
          );
          assert.equal(Exit.isFailure(flushFailure), true);
          const afterFlushFailure = yield* Effect.promise(async () => {
            const customer = await admin.query<{ readonly version: number }>(
              'select version from crm.customers where customer_id = $1',
              [customerId],
            );
            const contacts = await admin.query<{
              readonly contact_id: string;
              readonly is_primary_contact: boolean;
              readonly version: number;
            }>(
              'select contact_id, is_primary_contact, version from crm.contacts where customer_id = $1 order by contact_id',
              [customerId],
            );
            const audit = await admin.query<{ readonly count: string }>(
              'select count(*)::text as count from core.audit_events where tenant_id = $1',
              [tenantId],
            );
            const dataAccess = await admin.query<{ readonly count: string }>(
              'select count(*)::text as count from core.data_access_events where tenant_id = $1',
              [tenantId],
            );
            const domain = await admin.query<{ readonly count: string }>(
              'select count(*)::text as count from core.domain_events where tenant_id = $1',
              [tenantId],
            );
            const counts = [audit, dataAccess, domain];
            return { contacts: contacts.rows, counts, customer: customer.rows };
          });
          assert.deepEqual(afterFlushFailure.contacts, beforeFlushFailure.contacts);
          assert.deepEqual(afterFlushFailure.customer, beforeFlushFailure.customer);
          assert.deepEqual(
            afterFlushFailure.counts.map(({ rows }) => rows[0]?.count),
            beforeFlushFailure.counts.map(({ rows }) => rows[0]?.count),
          );

          const beforeRollback = yield* Effect.promise(async () => {
            const audit = await admin.query<{ readonly count: string }>(
              'select count(*)::text as count from core.audit_events where tenant_id = $1',
              [tenantId],
            );
            const dataAccess = await admin.query<{ readonly count: string }>(
              'select count(*)::text as count from core.data_access_events where tenant_id = $1',
              [tenantId],
            );
            const domain = await admin.query<{ readonly count: string }>(
              'select count(*)::text as count from core.domain_events where tenant_id = $1',
              [tenantId],
            );
            return [audit, dataAccess, domain] as const;
          });
          const stale = yield* Effect.exit(
            runtime.runAction({
              payload: { ...payload, expectedCustomerVersion: 1 },
              principal,
              registration: changeCustomerPrimaryContactAction,
              transport: transport('primary-contact-live-stale'),
            }),
          );
          assert.equal(Exit.isFailure(stale), true);
          assert.match(JSON.stringify(stale), /ChangeCustomerPrimaryContactConflict/u);
          const afterRollback = yield* Effect.promise(async () => {
            const audit = await admin.query<{ readonly count: string }>(
              'select count(*)::text as count from core.audit_events where tenant_id = $1',
              [tenantId],
            );
            const dataAccess = await admin.query<{ readonly count: string }>(
              'select count(*)::text as count from core.data_access_events where tenant_id = $1',
              [tenantId],
            );
            const domain = await admin.query<{ readonly count: string }>(
              'select count(*)::text as count from core.domain_events where tenant_id = $1',
              [tenantId],
            );
            return [audit, dataAccess, domain] as const;
          });
          assert.deepEqual(
            afterRollback.map(({ rows }) => rows[0]?.count),
            beforeRollback.map(({ rows }) => rows[0]?.count),
          );

          const invocationCount = yield* Effect.promise(() =>
            admin.query<{ readonly count: string }>(
              'select count(*)::text as count from core.action_invocations where tenant_id = $1',
              [tenantId],
            ),
          );
          const { legalEntityId: _omittedLegalEntityId, ...principalWithoutLegalEntity } =
            principal;
          const missingContext = yield* Effect.exit(
            runtime.runAction({
              payload,
              principal: principalWithoutLegalEntity,
              registration: changeCustomerPrimaryContactAction,
              transport: transport('primary-contact-live-no-context'),
            }),
          );
          assert.equal(Exit.isFailure(missingContext), true);
          assert.match(JSON.stringify(missingContext), /OperationContextDenied/u);
          const invocationCountAfter = yield* Effect.promise(() =>
            admin.query<{ readonly count: string }>(
              'select count(*)::text as count from core.action_invocations where tenant_id = $1',
              [tenantId],
            ),
          );
          assert.equal(invocationCountAfter.rows[0]?.count, invocationCount.rows[0]?.count);
        }).pipe(Effect.provide(actionRuntimeLive)),
      ),
    );
  } finally {
    await admin.query(
      'alter table core.domain_events drop constraint if exists core_domain_events_reject_primary_contact_test_ck',
    );
    await spiceDbClient.promises.deleteRelationships(
      v1.DeleteRelationshipsRequest.create({
        relationshipFilter: v1.RelationshipFilter.create({
          optionalResourceId: actionObjectId,
          resourceType: 'action',
        }),
      }),
    );
    spiceDbClient.close();
    await cleanup();
    await admin.end();
  }
});
