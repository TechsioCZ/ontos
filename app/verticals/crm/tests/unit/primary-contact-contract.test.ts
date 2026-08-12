/* eslint-disable unicorn/consistent-function-scoping, unicorn/no-thenable -- The scoped Drizzle test double intentionally models fluent awaitable query builders. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Effect, Schema } from 'effect';
import { ChangeCustomerPrimaryContactPayloadSchema } from '../../shared/apis/change-customer-primary-contact-action.ts';
import { changeCustomerPrimaryContactAction } from '../../src/actions/change-customer-primary-contact.action.ts';
import { makeContactService } from '../../src/contacts/contact-service.ts';

const customerId = '10000000-0000-4000-8000-000000000001';
const contactId = '20000000-0000-4000-8000-000000000001';
const previousContactId = '20000000-0000-4000-8000-000000000002';
const tenantId = '30000000-0000-4000-8000-000000000001';
const changedAt = new Date('2026-08-12T10:00:00.000Z');

const customerRow = (version: number) => ({
  addressLine1: null,
  addressLine2: null,
  city: null,
  companyRegistrationNumber: null,
  countryCode: null,
  createdAt: changedAt,
  customerId,
  deletedAt: null,
  email: null,
  name: 'Primary Contact unit Customer',
  phone: null,
  postalCode: null,
  region: null,
  taxIdentificationNumber: null,
  tenantId,
  updatedAt: changedAt,
  version,
  website: null,
});
const contactRow = (
  nextContactId: string,
  version: number,
  isPrimaryContact: boolean,
  nextCustomerId = customerId,
) => ({
  contactId: nextContactId,
  customerId: nextCustomerId,
  isPrimaryContact,
  version,
});

const queuedTransaction = (
  selectResults: readonly (readonly object[])[],
  updateResults: readonly (readonly object[])[],
) => {
  const selects = [...selectResults];
  const updates = [...updateResults];
  const query = (result: readonly object[] | undefined) => {
    const builder: Record<string, unknown> = {};
    for (const method of ['for', 'from', 'limit', 'orderBy', 'returning', 'set', 'where']) {
      builder[method] = () => builder;
    }
    builder['then'] = (resolve: (value: readonly object[]) => unknown) =>
      Promise.resolve(resolve(result ?? []));
    return builder;
  };
  return {
    select: () => query(selects.shift()),
    update: () => query(updates.shift()),
  };
};

const runDecision = (
  input: Parameters<ReturnType<typeof makeContactService>['changeCustomerPrimaryContact']>[0],
  selectResults: readonly (readonly object[])[],
  updateResults: readonly (readonly object[])[],
) =>
  Effect.runPromise(
    makeContactService(
      queuedTransaction(selectResults, updateResults) as never,
      tenantId,
      () => changedAt,
    ).changeCustomerPrimaryContact(input),
  );

const decode = (input: unknown) =>
  Effect.runPromise(Schema.decodeUnknownEffect(ChangeCustomerPrimaryContactPayloadSchema)(input));

test('declares the exact scope-free primary Contact concurrency payload', async () => {
  assert.deepEqual(
    await decode({
      customerId,
      expectedCurrentPrimaryContactId: null,
      expectedCurrentPrimaryContactVersion: null,
      expectedCustomerVersion: 3,
      expectedSelectedContactVersion: 2,
      legalEntityId: 'forbidden',
      selectedContactId: contactId,
      tenantId: 'forbidden',
    }),
    {
      customerId,
      expectedCurrentPrimaryContactId: null,
      expectedCurrentPrimaryContactVersion: null,
      expectedCustomerVersion: 3,
      expectedSelectedContactVersion: 2,
      selectedContactId: contactId,
    },
  );
  await assert.rejects(
    decode({
      customerId,
      expectedCurrentPrimaryContactId: null,
      expectedCurrentPrimaryContactVersion: null,
      expectedCustomerVersion: 3,
      selectedContactId: contactId,
    }),
  );
  await assert.rejects(
    decode({
      customerId,
      expectedCurrentPrimaryContactId: null,
      expectedCurrentPrimaryContactVersion: null,
      expectedCustomerVersion: 0,
      expectedSelectedContactVersion: null,
      selectedContactId: null,
    }),
  );
});

test('rejects inconsistent nullable ID/version pairs before persistence', async () => {
  const service = makeContactService({} as never, '30000000-0000-4000-8000-000000000001');
  const currentPair = await Effect.runPromise(
    Effect.flip(
      service.changeCustomerPrimaryContact({
        customerId,
        expectedCurrentPrimaryContactId: contactId,
        expectedCurrentPrimaryContactVersion: null,
        expectedCustomerVersion: 1,
        expectedSelectedContactVersion: null,
        selectedContactId: null,
      }),
    ),
  );
  assert.equal(currentPair._tag, 'ChangeCustomerPrimaryContactRejected');

  const selectedPair = await Effect.runPromise(
    Effect.flip(
      service.changeCustomerPrimaryContact({
        customerId,
        expectedCurrentPrimaryContactId: null,
        expectedCurrentPrimaryContactVersion: null,
        expectedCustomerVersion: 1,
        expectedSelectedContactVersion: 1,
        selectedContactId: null,
      }),
    ),
  );
  assert.equal(selectedPair._tag, 'ChangeCustomerPrimaryContactRejected');
});

test('decides focused set, replace, and clear transitions with committed versions', async () => {
  const set = await runDecision(
    {
      customerId,
      expectedCurrentPrimaryContactId: null,
      expectedCurrentPrimaryContactVersion: null,
      expectedCustomerVersion: 1,
      expectedSelectedContactVersion: 1,
      selectedContactId: contactId,
    },
    [[customerRow(1)], [contactRow(contactId, 1, false)]],
    [[contactRow(contactId, 2, true)], [{ version: 2 }]],
  );
  assert.equal(set.result.primaryContactId, contactId);
  assert.equal(set.result.customerVersion, 2);

  const replaced = await runDecision(
    {
      customerId,
      expectedCurrentPrimaryContactId: previousContactId,
      expectedCurrentPrimaryContactVersion: 3,
      expectedCustomerVersion: 2,
      expectedSelectedContactVersion: 1,
      selectedContactId: contactId,
    },
    [[customerRow(2)], [contactRow(previousContactId, 3, true), contactRow(contactId, 1, false)]],
    [[contactRow(previousContactId, 4, false)], [contactRow(contactId, 2, true)], [{ version: 3 }]],
  );
  assert.equal(replaced.result.previousPrimaryContactId, previousContactId);
  assert.equal(replaced.result.previousPrimaryContactVersion, 4);
  assert.equal(replaced.result.primaryContactId, contactId);

  const cleared = await runDecision(
    {
      customerId,
      expectedCurrentPrimaryContactId: contactId,
      expectedCurrentPrimaryContactVersion: 2,
      expectedCustomerVersion: 3,
      expectedSelectedContactVersion: null,
      selectedContactId: null,
    },
    [[customerRow(3)], [contactRow(contactId, 2, true)]],
    [[contactRow(contactId, 3, false)], [{ version: 4 }]],
  );
  assert.equal(cleared.result.previousPrimaryContactId, contactId);
  assert.equal(cleared.result.primaryContactId, null);
  assert.equal(cleared.result.customerVersion, 4);
});

test('rejects a visible selected Contact owned by another Customer', async () => {
  const failure = await Effect.runPromise(
    Effect.flip(
      makeContactService(
        queuedTransaction(
          [
            [customerRow(1)],
            [],
            [contactRow(contactId, 1, false, '10000000-0000-4000-8000-000000000099')],
          ],
          [],
        ) as never,
        tenantId,
      ).changeCustomerPrimaryContact({
        customerId,
        expectedCurrentPrimaryContactId: null,
        expectedCurrentPrimaryContactVersion: null,
        expectedCustomerVersion: 1,
        expectedSelectedContactVersion: 1,
        selectedContactId: contactId,
      }),
    ),
  );
  assert.equal(failure._tag, 'ChangeCustomerPrimaryContactRejected');
});

test('publishes one generated idempotent Action and one past-tense event contract', () => {
  assert.equal(changeCustomerPrimaryContactAction.descriptor.owningModuleKey, 'crm.core');
  assert.equal(changeCustomerPrimaryContactAction.descriptor.entrypoint.access, 'write');
  assert.equal(changeCustomerPrimaryContactAction.descriptor.idempotency, 'required');
  assert.equal(changeCustomerPrimaryContactAction.descriptor.legalEntityScope, 'required');
  assert.deepEqual(Object.keys(changeCustomerPrimaryContactAction.descriptor.domainEvents), [
    'crm.core.customer.primary-contact-changed',
  ]);
});

test('maps the complete generated BFF failure vocabulary and keeps the client private-safe', async () => {
  const server = await readFile(
    path.resolve(import.meta.dirname, '../../api/change-customer-primary-contact-action-server.ts'),
    'utf-8',
  );
  for (const status of ['400', '401', '403', '404', '409', '422', '500', '503']) {
    assert.match(server, new RegExp(`${status} as const`, 'u'));
  }
  assert.match(server, /ChangeCustomerPrimaryContactUnavailable/u);
  assert.match(server, /www-authenticate/u);
  assert.doesNotMatch(server, /primary-contact\.handler/u);

  const client = await readFile(
    path.resolve(
      import.meta.dirname,
      '../../src/api/change-customer-primary-contact-action-client.ts',
    ),
    'utf-8',
  );
  assert.match(client, /makeEffectHttpApiClient/u);
  assert.doesNotMatch(client, /handler|contact-repository|contact-service/u);
});
