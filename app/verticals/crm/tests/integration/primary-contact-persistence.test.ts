/* eslint-disable max-lines, no-await-in-loop, unicorn/no-await-expression-member -- One ordered PostgreSQL scenario carries versions forward through every primary-contact transition and race. */
import assert from 'node:assert/strict';
// @effect-diagnostics asyncFunction:off
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Cause, Effect, Exit } from 'effect';
import { Client, Pool } from 'pg';
import type { ChangeCustomerPrimaryContactPayload } from '../../shared/apis/change-customer-primary-contact-action.ts';
import { makeContactRepository } from '../../src/contacts/contact-repository.ts';
import { makeContactService } from '../../src/contacts/contact-service.ts';
import { loadCrmDatabaseConnectionPair } from '../../src/db/config.ts';
import { crmDatabaseSchema } from '../../src/db/schema.ts';

const tenantA = '86000000-0000-4000-8000-000000000001';
const tenantB = '86000000-0000-4000-8000-000000000002';
const customerA = '87000000-0000-4000-8000-000000000001';
const foreignCustomer = '87000000-0000-4000-8000-000000000002';
const tenantBCustomer = '87000000-0000-4000-8000-000000000003';
const contact1 = '88000000-0000-4000-8000-000000000001';
const contact2 = '88000000-0000-4000-8000-000000000002';
const contact3 = '88000000-0000-4000-8000-000000000003';
const contact4 = '88000000-0000-4000-8000-000000000004';
const foreignContact = '88000000-0000-4000-8000-000000000005';
const deletedContact = '88000000-0000-4000-8000-000000000006';
const tenantBContact = '88000000-0000-4000-8000-000000000007';

test('enforces atomic set, replace, clear, uniqueness, RLS, concurrency, and rollback', async () => {
  const configuration = await Effect.runPromise(loadCrmDatabaseConnectionPair());
  const admin = new Client({ connectionString: configuration.admin.connectionString });
  const runtimePool = new Pool({ connectionString: configuration.runtime.connectionString });
  await admin.connect();

  const cleanup = async () => {
    await admin.query('delete from crm.contacts where tenant_id = any($1::uuid[])', [
      [tenantA, tenantB],
    ]);
    await admin.query('delete from crm.customers where tenant_id = any($1::uuid[])', [
      [tenantA, tenantB],
    ]);
  };

  try {
    await cleanup();
    await admin.query(
      `insert into crm.customers (customer_id, tenant_id, name)
       values ($1, $2, 'Primary customer'), ($3, $2, 'Foreign customer'), ($4, $5, 'Other tenant')`,
      [customerA, tenantA, foreignCustomer, tenantBCustomer, tenantB],
    );
    await admin.query(
      `insert into crm.contacts
        (contact_id, tenant_id, customer_id, first_name, deleted_at)
       values
        ($1, $8, $9, 'One', null),
        ($2, $8, $9, 'Two', null),
        ($3, $8, $9, 'Three', null),
        ($4, $8, $9, 'Four', null),
        ($5, $8, $10, 'Foreign', null),
        ($6, $8, $9, 'Deleted', now()),
        ($7, $11, $12, 'Other tenant', null)`,
      [
        contact1,
        contact2,
        contact3,
        contact4,
        foreignContact,
        deletedContact,
        tenantBContact,
        tenantA,
        customerA,
        foreignCustomer,
        tenantB,
        tenantBCustomer,
      ],
    );

    await admin.query('begin');
    await admin.query('update crm.contacts set is_primary_contact = true where contact_id = $1', [
      contact1,
    ]);
    await admin.query('savepoint second_primary');
    await assert.rejects(
      admin.query('update crm.contacts set is_primary_contact = true where contact_id = $1', [
        contact2,
      ]),
      (error: { readonly code?: string; readonly constraint?: string }) =>
        error.code === '23505' && error.constraint === 'crm_contacts_active_primary_uk',
    );
    await admin.query('rollback to savepoint second_primary');
    await admin.query('update crm.contacts set is_primary_contact = false where contact_id = $1', [
      contact1,
    ]);
    await admin.query('commit');

    const database = drizzle({ client: runtimePool, schema: crmDatabaseSchema });
    const run = (payload: ChangeCustomerPrimaryContactPayload) =>
      database.transaction(async (transaction) => {
        await transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantA}, true)`);
        const service = makeContactService(
          transaction,
          tenantA,
          () => new Date('2026-08-12T10:00:00.000Z'),
        );
        return Effect.runPromise(Effect.exit(service.changeCustomerPrimaryContact(payload)));
      });

    const set = await run({
      customerId: customerA,
      expectedCurrentPrimaryContactId: null,
      expectedCurrentPrimaryContactVersion: null,
      expectedCustomerVersion: 1,
      expectedSelectedContactVersion: 1,
      selectedContactId: contact1,
    });
    assert.equal(Exit.isSuccess(set), true);
    if (Exit.isSuccess(set)) {
      assert.deepEqual(set.value, {
        dataAccess: set.value.dataAccess,
        result: {
          changedAt: '2026-08-12T10:00:00.000Z',
          customerId: customerA,
          customerVersion: 2,
          previousPrimaryContactId: null,
          previousPrimaryContactVersion: null,
          primaryContactId: contact1,
          primaryContactVersion: 2,
        },
      });
      assert.equal(set.value.dataAccess.length, 3);
    }

    const uniqueMapped = await database.transaction(async (transaction) => {
      await transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantA}, true)`);
      return Effect.runPromise(
        Effect.flip(
          makeContactRepository(transaction).updatePrimaryStatus(
            tenantA,
            customerA,
            contact2,
            1,
            true,
            new Date('2026-08-12T10:01:00.000Z'),
          ),
        ),
      );
    });
    assert.equal(uniqueMapped._tag, 'PrimaryContactRepositoryConflict');

    const staleSelected = await run({
      customerId: customerA,
      expectedCurrentPrimaryContactId: contact1,
      expectedCurrentPrimaryContactVersion: 2,
      expectedCustomerVersion: 2,
      expectedSelectedContactVersion: 2,
      selectedContactId: contact2,
    });
    assert.equal(Exit.isFailure(staleSelected), true);

    const replaced = await run({
      customerId: customerA,
      expectedCurrentPrimaryContactId: contact1,
      expectedCurrentPrimaryContactVersion: 2,
      expectedCustomerVersion: 2,
      expectedSelectedContactVersion: 1,
      selectedContactId: contact2,
    });
    assert.equal(Exit.isSuccess(replaced), true);
    if (Exit.isSuccess(replaced)) {
      assert.equal(replaced.value.result.customerVersion, 3);
      assert.equal(replaced.value.result.previousPrimaryContactVersion, 3);
      assert.equal(replaced.value.result.primaryContactVersion, 2);
    }

    const alreadyPrimary = await run({
      customerId: customerA,
      expectedCurrentPrimaryContactId: contact2,
      expectedCurrentPrimaryContactVersion: 2,
      expectedCustomerVersion: 3,
      expectedSelectedContactVersion: 2,
      selectedContactId: contact2,
    });
    assert.equal(Exit.isFailure(alreadyPrimary), true);

    const cleared = await run({
      customerId: customerA,
      expectedCurrentPrimaryContactId: contact2,
      expectedCurrentPrimaryContactVersion: 2,
      expectedCustomerVersion: 3,
      expectedSelectedContactVersion: null,
      selectedContactId: null,
    });
    assert.equal(Exit.isSuccess(cleared), true);
    if (Exit.isSuccess(cleared)) {
      assert.equal(cleared.value.result.customerVersion, 4);
      assert.equal(cleared.value.result.previousPrimaryContactVersion, 3);
      assert.equal(cleared.value.result.primaryContactId, null);
    }

    const alreadyClear = await run({
      customerId: customerA,
      expectedCurrentPrimaryContactId: null,
      expectedCurrentPrimaryContactVersion: null,
      expectedCustomerVersion: 4,
      expectedSelectedContactVersion: null,
      selectedContactId: null,
    });
    assert.equal(Exit.isFailure(alreadyClear), true);

    for (const [selectedContactId, expectedTag] of [
      [foreignContact, 'ChangeCustomerPrimaryContactRejected'],
      [deletedContact, 'ChangeCustomerPrimaryContactNotFound'],
      [tenantBContact, 'ChangeCustomerPrimaryContactNotFound'],
    ] as const) {
      const result = await run({
        customerId: customerA,
        expectedCurrentPrimaryContactId: null,
        expectedCurrentPrimaryContactVersion: null,
        expectedCustomerVersion: 4,
        expectedSelectedContactVersion: 1,
        selectedContactId,
      });
      assert.equal(Exit.isFailure(result), true);
      if (Exit.isFailure(result)) {
        const failure = Cause.findErrorOption(result.cause);
        assert.equal(failure._tag, 'Some');
        if (failure._tag === 'Some') {
          assert.equal((failure.value as { readonly _tag?: string })._tag, expectedTag);
        }
      }
    }

    const competingPayload = (selectedContactId: string): ChangeCustomerPrimaryContactPayload => ({
      customerId: customerA,
      expectedCurrentPrimaryContactId: null,
      expectedCurrentPrimaryContactVersion: null,
      expectedCustomerVersion: 4,
      expectedSelectedContactVersion: 1,
      selectedContactId,
    });
    const competing = await Promise.all([
      run(competingPayload(contact3)),
      run(competingPayload(contact4)),
    ]);
    assert.equal(competing.filter(Exit.isSuccess).length, 1);
    assert.equal(competing.filter(Exit.isFailure).length, 1);

    const [currentPrimary] = (
      await admin.query<{
        readonly contact_id: string;
        readonly version: number;
      }>(
        'select contact_id, version from crm.contacts where customer_id = $1 and is_primary_contact and deleted_at is null',
        [customerA],
      )
    ).rows;
    assert.ok(currentPrimary !== undefined);
    const replacementContactId = currentPrimary.contact_id === contact3 ? contact4 : contact3;
    const [replacement] = (
      await admin.query<{ readonly version: number }>(
        'select version from crm.contacts where contact_id = $1',
        [replacementContactId],
      )
    ).rows;
    assert.ok(replacement !== undefined);
    const raceBase = {
      customerId: customerA,
      expectedCurrentPrimaryContactId: currentPrimary.contact_id,
      expectedCurrentPrimaryContactVersion: currentPrimary.version,
      expectedCustomerVersion: 5,
    } as const;
    const clearVersusSet = await Promise.all([
      run({
        ...raceBase,
        expectedSelectedContactVersion: null,
        selectedContactId: null,
      }),
      run({
        ...raceBase,
        expectedSelectedContactVersion: replacement.version,
        selectedContactId: replacementContactId,
      }),
    ]);
    assert.equal(clearVersusSet.filter(Exit.isSuccess).length, 1);
    assert.equal(clearVersusSet.filter(Exit.isFailure).length, 1);

    const beforeRollback = await admin.query<{
      readonly contact_id: string;
      readonly is_primary_contact: boolean;
      readonly version: number;
    }>(
      'select contact_id, is_primary_contact, version from crm.contacts where customer_id = $1 order by contact_id',
      [customerA],
    );
    const [customerBeforeRollback] = (
      await admin.query<{ readonly version: number }>(
        'select version from crm.customers where customer_id = $1',
        [customerA],
      )
    ).rows;
    assert.ok(customerBeforeRollback !== undefined);
    const rollbackCurrent = beforeRollback.rows.find(
      ({ is_primary_contact }) => is_primary_contact,
    );
    const rollbackSelected = beforeRollback.rows.find(
      ({ contact_id, is_primary_contact }) =>
        !is_primary_contact &&
        contact_id !== deletedContact &&
        contact_id !== rollbackCurrent?.contact_id,
    );
    assert.ok(rollbackSelected !== undefined);
    await assert.rejects(
      database.transaction(async (transaction) => {
        await transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantA}, true)`);
        const service = makeContactService(transaction, tenantA);
        await Effect.runPromise(
          service.changeCustomerPrimaryContact({
            customerId: customerA,
            expectedCurrentPrimaryContactId: rollbackCurrent?.contact_id ?? null,
            expectedCurrentPrimaryContactVersion: rollbackCurrent?.version ?? null,
            expectedCustomerVersion: customerBeforeRollback.version,
            expectedSelectedContactVersion: rollbackSelected.version,
            selectedContactId: rollbackSelected.contact_id,
          }),
        );
        throw new Error('force primary Contact rollback');
      }),
      /force primary Contact rollback/u,
    );
    const afterRollback = await admin.query<{
      readonly contact_id: string;
      readonly is_primary_contact: boolean;
      readonly version: number;
    }>(
      'select contact_id, is_primary_contact, version from crm.contacts where customer_id = $1 order by contact_id',
      [customerA],
    );
    assert.deepEqual(afterRollback.rows, beforeRollback.rows);

    const runtime = await runtimePool.connect();
    try {
      await runtime.query('begin');
      await runtime.query("select set_config('ontos.tenant_id', $1, true)", [tenantA]);
      const visible = await runtime.query<{ readonly tenant_id: string }>(
        'select tenant_id from crm.contacts',
      );
      assert.equal(
        visible.rows.every(({ tenant_id }) => tenant_id === tenantA),
        true,
      );
      const activePrimaries = await runtime.query<{ readonly count: string }>(
        'select count(*)::text as count from crm.contacts where customer_id = $1 and is_primary_contact and deleted_at is null',
        [customerA],
      );
      assert.equal(Number(activePrimaries.rows[0]?.count ?? '0') <= 1, true);
      await runtime.query('rollback');
    } finally {
      runtime.release();
    }
  } finally {
    await cleanup();
    await Promise.all([admin.end(), runtimePool.end()]);
  }
});
