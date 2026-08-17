/* eslint-disable no-await-in-loop, promise/prefer-await-to-callbacks, typescript/no-explicit-any -- The live fixture injects one Drizzle transaction fault and cleans dependent tenant rows in foreign-key order. */
// @effect-diagnostics asyncFunction:off anyUnknownInErrorContext:off
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  loadDatabaseConfig,
  loadDatabaseConnectionPair,
  makeOperationalScopeRepository,
  makeOperationalScopeResolver,
  makeTenantModuleStateService,
} from '@app/core-runtime';
import { eq } from 'drizzle-orm';
import { Effect } from 'effect';
import { Pool } from 'pg';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { makeCoreDatabase } from '../../../../packages/core-runtime/src/db/client.ts';
import { auditEvents, dataAccessEvents } from '../../../../packages/core-runtime/src/db/schema.ts';
import { makeModuleEntrypointGateway } from '../../../../packages/core-runtime/src/modules/module-entrypoint-gateway.ts';
import { makeModuleStateGate } from '../../../../packages/core-runtime/src/modules/module-state-gate.ts';
import { makeReadRuntime } from '../../../../packages/core-runtime/src/reads/runtime.ts';
import { archiveContactAction } from '../../src/actions/archive-contact.action.ts';
import { archiveCustomerAction } from '../../src/actions/archive-customer.action.ts';
import { createContactAction } from '../../src/actions/create-contact.action.ts';
import { createCustomerAction } from '../../src/actions/create-customer.action.ts';
import { editContactAction } from '../../src/actions/edit-contact.action.ts';
import { editCustomerAction } from '../../src/actions/edit-customer.action.ts';
import { unarchiveContactAction } from '../../src/actions/unarchive-contact.action.ts';
import { unarchiveCustomerAction } from '../../src/actions/unarchive-customer.action.ts';
import { contactDetailRead } from '../../src/api/contact-detail.read.ts';
import { contactListRead } from '../../src/api/contact-list.read.ts';
import { customerDetailRead } from '../../src/api/customer-detail.read.ts';
import { customerListRead } from '../../src/api/customer-list.read.ts';
import { CrmPersistenceUnavailable } from '../../shared/apis/customer-detail.ts';
import { customers } from '../../src/db/schema.ts';

const tenantId = randomUUID();
const principalId = randomUUID();
const otherTenantId = randomUUID();
const otherPrincipalId = randomUUID();
const principal = {
  authBindingId: randomUUID(),
  authContextRef: 'better-auth-session:crm-integration',
  authMethod: 'session' as const,
  principalId,
  tenantId,
};
const otherPrincipal = {
  authBindingId: randomUUID(),
  authContextRef: 'better-auth-session:crm-integration-other',
  authMethod: 'session' as const,
  principalId: otherPrincipalId,
  tenantId: otherTenantId,
};

const transport = (idempotencyKey?: string) => ({
  correlationId: randomUUID(),
  ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
});

const contextAccess = {
  legalEntities: () => Effect.succeed([]),
  modules: () => Effect.succeed([]),
  resources: () => Effect.succeed([]),
  tenants: (input: { readonly tenantIds: readonly string[] }) =>
    Effect.succeed(
      input.tenantIds.map((candidate) => ({
        decision: 'allowed' as const,
        key: candidate,
      })),
    ),
};

const failingEvidenceDatabase = (database: { readonly executor: any }) => ({
  executor: new Proxy(database.executor, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property !== 'transaction' || typeof value !== 'function') {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (callback: (transaction: any) => PromiseLike<unknown>) =>
        (value as (callback: (transaction: any) => PromiseLike<unknown>) => Promise<unknown>).call(
          target,
          (transaction) =>
            callback(
              new Proxy(transaction, {
                get(transactionTarget, operation) {
                  const transactionValue = Reflect.get(
                    transactionTarget,
                    operation,
                    transactionTarget,
                  ) as unknown;
                  if (operation === 'insert' && typeof transactionValue === 'function') {
                    return (table: unknown) => {
                      if (table === dataAccessEvents) {
                        throw new Error('Injected CRM evidence persistence failure');
                      }
                      return (transactionValue as (targetTable: unknown) => unknown).call(
                        transactionTarget,
                        table,
                      );
                    };
                  }
                  return typeof transactionValue === 'function'
                    ? transactionValue.bind(transactionTarget)
                    : transactionValue;
                },
              }),
            ),
        );
    },
  }),
});

test('runs CRM writes and reads through the governed runtimes with durable evidence', async () => {
  const configuration = await Effect.runPromise(loadDatabaseConfig());
  const connections = await Effect.runPromise(loadDatabaseConnectionPair());
  const adminPool = new Pool({ connectionString: connections.admin.connectionString });
  try {
    await adminPool.query(
      `insert into core.tenants (tenant_id, slug, name, status, default_locale)
       values ($1, $2, 'CRM operations integration', 'active', 'en')`,
      [tenantId, `crm-operations-${tenantId}`],
    );
    await adminPool.query(
      `insert into core.principals (principal_id, tenant_id, kind, display_name, status)
       values ($1, $2, 'human', 'CRM operations principal', 'active')`,
      [principalId, tenantId],
    );
    await adminPool.query(
      `insert into core.principal_auth_bindings
         (principal_auth_binding_id, tenant_id, principal_id, provider, provider_subject_id, subject_type, status)
       values ($1, $2, $3, 'better_auth', $4, 'user', 'active')`,
      [principal.authBindingId, tenantId, principalId, `crm-operations-${principalId}`],
    );
    await adminPool.query(
      `insert into core.tenant_module_states (tenant_id, module_key, state)
       values ($1, 'crm.core', 'active')`,
      [tenantId],
    );
    await adminPool.query(
      `insert into core.tenants (tenant_id, slug, name, status, default_locale)
       values ($1, $2, 'CRM operations other tenant', 'active', 'en')`,
      [otherTenantId, `crm-operations-${otherTenantId}`],
    );
    await adminPool.query(
      `insert into core.principals (principal_id, tenant_id, kind, display_name, status)
       values ($1, $2, 'human', 'CRM operations other principal', 'active')`,
      [otherPrincipalId, otherTenantId],
    );
    await adminPool.query(
      `insert into core.principal_auth_bindings
         (principal_auth_binding_id, tenant_id, principal_id, provider, provider_subject_id, subject_type, status)
       values ($1, $2, $3, 'better_auth', $4, 'user', 'active')`,
      [
        otherPrincipal.authBindingId,
        otherTenantId,
        otherPrincipalId,
        `crm-operations-${otherPrincipalId}`,
      ],
    );
    await adminPool.query(
      `insert into core.tenant_module_states (tenant_id, module_key, state)
       values ($1, 'crm.core', 'active')`,
      [otherTenantId],
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* governedOperations() {
          const database = yield* makeCoreDatabase(configuration);
          const moduleStateGate = makeModuleStateGate(makeTenantModuleStateService(database));
          const moduleGateway = makeModuleEntrypointGateway(moduleStateGate);
          const scopeResolver = makeOperationalScopeResolver(
            makeOperationalScopeRepository(database),
            contextAccess,
          );
          const actions = makeActionRuntime(
            database,
            makeActionRepository(),
            { checkActionPermission: () => Effect.succeed('unconfigured' as const) },
            scopeResolver,
            { moduleEntrypointGateway: moduleGateway, moduleStateGate },
          );
          const rollbackActions = makeActionRuntime(
            database,
            makeActionRepository(),
            { checkActionPermission: () => Effect.succeed('unconfigured' as const) },
            scopeResolver,
            {
              moduleEntrypointGateway: moduleGateway,
              moduleStateGate,
              resolveServiceFactory: (() => (transaction: any, scope: any) =>
                Effect.succeed({
                  create: (payload: { readonly name: string }) =>
                    Effect.tryPromise({
                      catch: () =>
                        new CrmPersistenceUnavailable({
                          code: 'crm_persistence_unavailable',
                          reason: 'Injected failure after the Customer write',
                        }),
                      try: () =>
                        transaction
                          .insert(customers)
                          .values({ name: payload.name, tenantId: scope.tenantId })
                          .returning(),
                    }).pipe(
                      Effect.andThen(
                        Effect.fail(
                          new CrmPersistenceUnavailable({
                            code: 'crm_persistence_unavailable',
                            reason: 'Injected failure after the Customer write',
                          }),
                        ),
                      ),
                    ),
                })) as never,
            },
          );
          const reads = makeReadRuntime(database, moduleGateway, scopeResolver, contextAccess);
          const verifyReadEvidence = <Success, Failure, Requirements>(
            operation: Effect.Effect<Success, Failure, Requirements>,
            expected: {
              readonly accessKind: 'list' | 'read';
              readonly authBindingId: string;
              readonly policyKey: string;
              readonly principalId: string;
              readonly resultCount: (result: Success) => number;
              readonly tenantId: string;
            },
          ) =>
            Effect.gen(function* verifyOneReadEvidence() {
              const selectEvidence = () =>
                adminPool.query<{
                  access_kind: string;
                  action_invocation_id: string | null;
                  auth_binding_id: string | null;
                  evidence_capture_mode: string;
                  outcome: string;
                  outcome_code: string;
                  outcome_stage: string;
                  principal_id: string;
                  result_count: number;
                  serving_module_key: string;
                  target_module_key: string | null;
                  target_resource_id: string | null;
                  target_resource_type: string | null;
                }>(
                  `select access_kind, action_invocation_id, auth_binding_id,
                          evidence_capture_mode, outcome, outcome_code, outcome_stage,
                          principal_id, result_count, serving_module_key, target_module_key,
                          target_resource_id, target_resource_type
                     from core.data_access_events
                    where tenant_id = $1 and evidence_policy_key = $2
                    order by occurred_at, data_access_event_id`,
                  [expected.tenantId, expected.policyKey],
                );
              const before = yield* Effect.promise(selectEvidence);
              const result = yield* operation;
              const after = yield* Effect.promise(selectEvidence);
              assert.equal(after.rows.length, before.rows.length + 1);
              const row = after.rows.at(-1);
              assert.deepEqual(row, {
                access_kind: expected.accessKind,
                action_invocation_id: null,
                auth_binding_id: expected.authBindingId,
                evidence_capture_mode: 'metadata_only',
                outcome: 'allowed',
                outcome_code: 'read_allowed',
                outcome_stage: 'evidence',
                principal_id: expected.principalId,
                result_count: expected.resultCount(result),
                serving_module_key: 'crm.core',
                target_module_key: null,
                target_resource_id: null,
                target_resource_type: null,
              });
              return result;
            });
          const ownRead = (policyKey: string, accessKind: 'list' | 'read') => ({
            accessKind,
            authBindingId: principal.authBindingId,
            policyKey,
            principalId,
            tenantId,
          });

          const customer = yield* actions.runAction({
            payload: { name: '  Acme  ' },
            principal,
            registration: createCustomerAction,
            transport: transport('create-customer'),
          });
          assert.equal(customer.name, 'Acme');
          const replay = yield* Effect.flip(
            actions.runAction({
              payload: { name: '  Acme  ' },
              principal,
              registration: createCustomerAction,
              transport: transport('create-customer'),
            }),
          );
          assert.equal(replay._tag, 'ActionAlreadyCommitted');
          const conflictingReplay = yield* Effect.flip(
            actions.runAction({
              payload: { name: 'Different request' },
              principal,
              registration: createCustomerAction,
              transport: transport('create-customer'),
            }),
          );
          assert.equal(conflictingReplay._tag, 'ActionRequestHashConflict');

          const customersBeforeRollback = yield* Effect.promise(() =>
            adminPool.query<{ count: string }>(
              'select count(*) from crm.customers where tenant_id = $1',
              [tenantId],
            ),
          );
          const rollbackFailure = yield* Effect.flip(
            rollbackActions.runAction({
              payload: { name: 'Must roll back' },
              principal,
              registration: createCustomerAction,
              transport: transport('create-customer-rollback-after-write'),
            }),
          );
          assert.equal(rollbackFailure._tag, 'CrmPersistenceUnavailable');
          const customersAfterRollback = yield* Effect.promise(() =>
            adminPool.query<{ count: string }>(
              'select count(*) from crm.customers where tenant_id = $1',
              [tenantId],
            ),
          );
          assert.equal(
            customersAfterRollback.rows[0]?.count,
            customersBeforeRollback.rows[0]?.count,
          );

          const editedCustomer = yield* actions.runAction({
            payload: { customerId: customer.customerId, name: 'Acme Corporation' },
            principal,
            registration: editCustomerAction,
            transport: transport('edit-customer'),
          });
          assert.equal(editedCustomer.name, 'Acme Corporation');

          const contact = yield* actions.runAction({
            payload: {
              customerId: customer.customerId,
              email: '  Ada@Example.test  ',
              name: '  Ada  ',
              phone: '  +420 123  ',
            },
            principal,
            registration: createContactAction,
            transport: transport('create-contact'),
          });
          assert.equal(contact.customerId, customer.customerId);
          assert.equal(contact.email, 'ada@example.test');

          const contactsBeforeMissingParent = yield* Effect.promise(() =>
            adminPool.query<{ count: string }>(
              'select count(*) from crm.contacts where tenant_id = $1',
              [tenantId],
            ),
          );
          const missingParent = yield* Effect.flip(
            actions.runAction({
              payload: {
                customerId: randomUUID(),
                email: 'nobody@example.test',
                name: 'Nobody',
                phone: '+420 000',
              },
              principal,
              registration: createContactAction,
              transport: transport('create-contact-missing-parent'),
            }),
          );
          assert.equal(missingParent._tag, 'CrmCustomerNotFound');
          const contactsAfterMissingParent = yield* Effect.promise(() =>
            adminPool.query<{ count: string }>(
              'select count(*) from crm.contacts where tenant_id = $1',
              [tenantId],
            ),
          );
          assert.equal(
            contactsAfterMissingParent.rows[0]?.count,
            contactsBeforeMissingParent.rows[0]?.count,
          );

          const edited = yield* actions.runAction({
            payload: {
              contactId: contact.contactId,
              email: 'ada.lovelace@example.test',
              name: 'Ada Lovelace',
              phone: '+420 456',
            },
            principal,
            registration: editContactAction,
            transport: transport('edit-contact'),
          });
          assert.equal(edited.customerId, customer.customerId);

          const sameNameCustomers = [];
          for (const index of [1, 2, 3]) {
            sameNameCustomers.push(
              yield* actions.runAction({
                payload: { name: 'Same name' },
                principal,
                registration: createCustomerAction,
                transport: transport(`create-pagination-customer-${index}`),
              }),
            );
          }
          const [crossCustomer] = sameNameCustomers;
          assert.ok(crossCustomer);
          yield* Effect.promise(() =>
            adminPool.query(
              `update crm.customers
                  set ico = '00123456',
                      dic = 'CZ00123456',
                      legal_form_code = '112',
                      established_on = '2020-01-02',
                      dissolved_on = '2026-08-17'
                where tenant_id = $1 and customer_id = $2`,
              [tenantId, customer.customerId],
            ),
          );
          const crossCustomerContact = yield* actions.runAction({
            payload: {
              customerId: crossCustomer.customerId,
              email: 'isolated@example.test',
              name: 'Isolated Contact',
              phone: '+420 999',
            },
            principal,
            registration: createContactAction,
            transport: transport('create-cross-customer-contact'),
          });
          const firstPage = yield* verifyReadEvidence(
            reads.runRead({
              input: { filter: 'all', limit: 2, offset: 0 },
              principal,
              registration: customerListRead,
              transport: transport(),
            }),
            {
              ...ownRead('crm.core.api.customer-list.evidence.v1', 'list'),
              resultCount: (result) => result.items.length,
            },
          );
          const secondPage = yield* verifyReadEvidence(
            reads.runRead({
              input: { filter: 'all', limit: 2, offset: firstPage.nextOffset ?? 0 },
              principal,
              registration: customerListRead,
              transport: transport(),
            }),
            {
              ...ownRead('crm.core.api.customer-list.evidence.v1', 'list'),
              resultCount: (result) => result.items.length,
            },
          );
          assert.equal(firstPage.nextOffset, 2);
          assert.equal(secondPage.nextOffset, null);
          assert.deepEqual(
            [...firstPage.items, ...secondPage.items]
              .filter((item) => item.name === 'Same name')
              .map((item) => item.customerId),
            sameNameCustomers.map((item) => item.customerId).toSorted(),
          );
          assert.deepEqual(
            [...firstPage.items, ...secondPage.items].find(
              (item) => item.customerId === customer.customerId,
            ),
            {
              ...editedCustomer,
              dic: 'CZ00123456',
              dissolvedOn: '2026-08-17',
              establishedOn: '2020-01-02',
              ico: '00123456',
              legalFormCode: '112',
            },
          );

          const detail = yield* verifyReadEvidence(
            reads.runRead({
              input: { customerId: customer.customerId },
              principal,
              registration: customerDetailRead,
              transport: transport(),
            }),
            {
              ...ownRead('crm.core.api.customer-detail.evidence.v1', 'read'),
              resultCount: () => 1,
            },
          );
          assert.deepEqual(detail, {
            ...editedCustomer,
            dic: 'CZ00123456',
            dissolvedOn: '2026-08-17',
            establishedOn: '2020-01-02',
            ico: '00123456',
            legalFormCode: '112',
          });
          const contactPage = yield* verifyReadEvidence(
            reads.runRead({
              input: { customerId: customer.customerId, limit: 10, offset: 0 },
              principal,
              registration: contactListRead,
              transport: transport(),
            }),
            {
              ...ownRead('crm.core.api.contact-list.evidence.v1', 'list'),
              resultCount: (result) => result.items.length,
            },
          );
          assert.deepEqual(
            contactPage.items.map((item) => item.contactId),
            [contact.contactId],
          );

          yield* actions.runAction({
            payload: { contactId: contact.contactId },
            principal,
            registration: archiveContactAction,
            transport: transport('archive-contact'),
          });
          const repeatedContactArchive = yield* Effect.flip(
            actions.runAction({
              payload: { contactId: contact.contactId },
              principal,
              registration: archiveContactAction,
              transport: transport('archive-contact-repeated'),
            }),
          );
          assert.equal(repeatedContactArchive._tag, 'CrmLifecycleConflict');
          const nonCascadeContact = yield* actions.runAction({
            payload: {
              customerId: customer.customerId,
              email: 'grace@example.test',
              name: 'Grace',
              phone: '+420 789',
            },
            principal,
            registration: createContactAction,
            transport: transport('create-non-cascade-contact'),
          });
          yield* actions.runAction({
            payload: { customerId: customer.customerId },
            principal,
            registration: archiveCustomerAction,
            transport: transport('archive-customer'),
          });
          const repeatedCustomerArchive = yield* Effect.flip(
            actions.runAction({
              payload: { customerId: customer.customerId },
              principal,
              registration: archiveCustomerAction,
              transport: transport('archive-customer-repeated'),
            }),
          );
          assert.equal(repeatedCustomerArchive._tag, 'CrmLifecycleConflict');
          const nonCascadedDetail = yield* verifyReadEvidence(
            reads.runRead({
              input: { contactId: nonCascadeContact.contactId },
              principal,
              registration: contactDetailRead,
              transport: transport(),
            }),
            {
              ...ownRead('crm.core.api.contact-detail.evidence.v1', 'read'),
              resultCount: () => 1,
            },
          );
          assert.equal(nonCascadedDetail.archivedAt, null);
          const archivedDetail = yield* verifyReadEvidence(
            reads.runRead({
              input: { contactId: contact.contactId },
              principal,
              registration: contactDetailRead,
              transport: transport(),
            }),
            {
              ...ownRead('crm.core.api.contact-detail.evidence.v1', 'read'),
              resultCount: () => 1,
            },
          );
          assert.ok(archivedDetail.archivedAt);
          const activeCustomers = yield* verifyReadEvidence(
            reads.runRead({
              input: { limit: 10, offset: 0 },
              principal,
              registration: customerListRead,
              transport: transport(),
            }),
            {
              ...ownRead('crm.core.api.customer-list.evidence.v1', 'list'),
              resultCount: (result) => result.items.length,
            },
          );
          assert.deepEqual(
            activeCustomers.items.map((item) => item.customerId),
            sameNameCustomers.map((item) => item.customerId).toSorted(),
          );
          const archivedCustomers = yield* verifyReadEvidence(
            reads.runRead({
              input: { filter: 'archived', limit: 10, offset: 0 },
              principal,
              registration: customerListRead,
              transport: transport(),
            }),
            {
              ...ownRead('crm.core.api.customer-list.evidence.v1', 'list'),
              resultCount: (result) => result.items.length,
            },
          );
          assert.deepEqual(
            archivedCustomers.items.map((item) => item.customerId),
            [customer.customerId],
          );

          const restoredContact = yield* actions.runAction({
            payload: { contactId: contact.contactId },
            principal,
            registration: unarchiveContactAction,
            transport: transport('unarchive-contact'),
          });
          assert.equal(restoredContact.archivedAt, null);
          const restoredCustomer = yield* actions.runAction({
            payload: { customerId: customer.customerId },
            principal,
            registration: unarchiveCustomerAction,
            transport: transport('unarchive-customer'),
          });
          assert.equal(restoredCustomer.archivedAt, null);

          const crossCustomerContacts = yield* verifyReadEvidence(
            reads.runRead({
              input: {
                customerId: crossCustomer.customerId,
                limit: 10,
                offset: 0,
              },
              principal,
              registration: contactListRead,
              transport: transport(),
            }),
            {
              ...ownRead('crm.core.api.contact-list.evidence.v1', 'list'),
              resultCount: (result) => result.items.length,
            },
          );
          assert.deepEqual(
            crossCustomerContacts.items.map((item) => item.contactId),
            [crossCustomerContact.contactId],
          );
          const absentCustomer = yield* Effect.flip(
            reads.runRead({
              input: { customerId: randomUUID() },
              principal,
              registration: customerDetailRead,
              transport: transport(),
            }),
          );
          assert.equal(absentCustomer._tag, 'ReadHandlerNotFound');
          const foreignDetail = yield* Effect.flip(
            reads.runRead({
              input: { customerId: customer.customerId },
              principal: otherPrincipal,
              registration: customerDetailRead,
              transport: transport(),
            }),
          );
          assert.equal(foreignDetail._tag, 'ReadHandlerNotFound');
          const foreignList = yield* verifyReadEvidence(
            reads.runRead({
              input: { filter: 'all', limit: 10, offset: 0 },
              principal: otherPrincipal,
              registration: customerListRead,
              transport: transport(),
            }),
            {
              accessKind: 'list',
              authBindingId: otherPrincipal.authBindingId,
              policyKey: 'crm.core.api.customer-list.evidence.v1',
              principalId: otherPrincipalId,
              resultCount: (result) => result.items.length,
              tenantId: otherTenantId,
            },
          );
          assert.deepEqual(foreignList.items, []);

          for (const state of ['read_only', 'deprecated'] as const) {
            yield* Effect.promise(() =>
              adminPool.query(
                "update core.tenant_module_states set state = $2 where tenant_id = $1 and module_key = 'crm.core'",
                [tenantId, state],
              ),
            );
            const stateRead = yield* verifyReadEvidence(
              reads.runRead({
                input: { customerId: customer.customerId },
                principal,
                registration: customerDetailRead,
                transport: transport(),
              }),
              {
                ...ownRead('crm.core.api.customer-detail.evidence.v1', 'read'),
                resultCount: () => 1,
              },
            );
            assert.equal(stateRead.customerId, customer.customerId);
            const deniedWrite = yield* Effect.flip(
              actions.runAction({
                payload: { customerId: customer.customerId, name: `Denied in ${state}` },
                principal,
                registration: editCustomerAction,
                transport: transport(`state-denied-${state}`),
              }),
            );
            assert.equal(deniedWrite._tag, 'ModuleStateDeniedError');
          }
          yield* Effect.promise(() =>
            adminPool.query(
              "update core.tenant_module_states set state = 'active' where tenant_id = $1 and module_key = 'crm.core'",
              [tenantId],
            ),
          );

          const evidenceFailingDatabase = failingEvidenceDatabase(database);
          const failingGate = makeModuleStateGate(
            makeTenantModuleStateService(evidenceFailingDatabase as never),
          );
          const failingGateway = makeModuleEntrypointGateway(failingGate);
          const failingScopeResolver = makeOperationalScopeResolver(
            makeOperationalScopeRepository(evidenceFailingDatabase as never),
            contextAccess,
          );
          const evidenceFailingReads = makeReadRuntime(
            evidenceFailingDatabase as never,
            failingGateway,
            failingScopeResolver,
            contextAccess,
          );
          const evidenceFailure = yield* Effect.flip(
            evidenceFailingReads.runRead({
              input: { customerId: customer.customerId },
              principal,
              registration: customerDetailRead,
              transport: transport(),
            }),
          );
          assert.equal(evidenceFailure._tag, 'ReadEvidencePersistenceError');

          const missingKey = yield* Effect.flip(
            actions.runAction({
              payload: { name: 'Missing key' },
              principal,
              registration: createCustomerAction,
              transport: transport(),
            }),
          );
          assert.equal(missingKey._tag, 'ActionIdempotencyKeyRequired');

          const evidence = yield* Effect.promise(() =>
            database.executor
              .select()
              .from(dataAccessEvents)
              .where(eq(dataAccessEvents.tenantId, tenantId)),
          );
          const standalone = evidence.filter((row) => row.actionInvocationId === null);
          assert.equal(standalone.length, 11);
          assert.ok(
            standalone.every(
              (row) =>
                row.outcome === 'allowed' &&
                row.outcomeStage === 'evidence' &&
                row.principalId === principalId &&
                row.authBindingId === principal.authBindingId &&
                row.actionInvocationId === null &&
                row.evidencePolicyKey.startsWith('crm.core.'),
            ),
          );
          const actionEvidence = evidence.filter((row) => row.actionInvocationId !== null);
          assert.equal(actionEvidence.length, 9);
          assert.deepEqual(
            actionEvidence
              .filter((row) => row.queryHash?.includes('lifecycle-state'))
              .map((row) => row.targetResourceType)
              .toSorted(),
            ['contact', 'contact', 'customer', 'customer'],
          );
          assert.ok(
            actionEvidence.every(
              (row) =>
                row.accessKind === 'read' &&
                row.resultCount === 1 &&
                row.principalId === principalId &&
                row.authBindingId === principal.authBindingId,
            ),
          );
          const otherEvidence = yield* Effect.promise(() =>
            database.executor
              .select()
              .from(dataAccessEvents)
              .where(eq(dataAccessEvents.tenantId, otherTenantId)),
          );
          assert.equal(otherEvidence.length, 1);
          assert.equal(otherEvidence[0]?.resultCount, 0);
          const successfulAudit = yield* Effect.promise(() =>
            database.executor.select().from(auditEvents).where(eq(auditEvents.tenantId, tenantId)),
          );
          const successfulActionAudit = successfulAudit.filter(
            (row) => row.outcome === 'succeeded',
          );
          assert.equal(successfulActionAudit.length, 13);
          assert.ok(
            successfulActionAudit.every(
              (row) =>
                row.auditProfile === 'standard' &&
                row.outcomeStage === 'execution' &&
                row.principalId === principalId &&
                row.authBindingId === principal.authBindingId &&
                row.actionInvocationId !== null,
            ),
          );
        }),
      ),
    );
    const customerCount = await adminPool.query<{ count: string }>(
      'select count(*) from crm.customers where tenant_id = $1',
      [tenantId],
    );
    assert.equal(customerCount.rows[0]?.count, '4');
  } finally {
    for (const cleanupTenantId of [tenantId, otherTenantId]) {
      await adminPool.query('delete from crm.contacts where tenant_id = $1', [cleanupTenantId]);
      await adminPool.query('delete from crm.customers where tenant_id = $1', [cleanupTenantId]);
      await adminPool.query('delete from core.data_access_events where tenant_id = $1', [
        cleanupTenantId,
      ]);
      await adminPool.query('delete from core.audit_events where tenant_id = $1', [
        cleanupTenantId,
      ]);
      await adminPool.query('delete from core.action_invocations where tenant_id = $1', [
        cleanupTenantId,
      ]);
      await adminPool.query('delete from core.tenant_module_states where tenant_id = $1', [
        cleanupTenantId,
      ]);
      await adminPool.query('delete from core.principal_auth_bindings where tenant_id = $1', [
        cleanupTenantId,
      ]);
      await adminPool.query('delete from core.principals where tenant_id = $1', [cleanupTenantId]);
      await adminPool.query('delete from core.tenants where tenant_id = $1', [cleanupTenantId]);
    }
    await adminPool.end();
  }
});
