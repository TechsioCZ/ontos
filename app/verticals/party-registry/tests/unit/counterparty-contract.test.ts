import assert from 'node:assert/strict';
import test from 'node:test';
import { Schema } from 'effect';
import {
  CounterpartyCreatePayloadSchema,
  CounterpartyCreateResultSchema,
  counterpartyCreateAction,
} from '../../src/actions/counterparty-create.action.ts';
import {
  CounterpartyRoleAddPayloadSchema,
  CounterpartyRoleAddResultSchema,
  counterpartyRoleAddAction,
} from '../../src/actions/counterparty-role-add.action.ts';
import {
  CounterpartyRoleEndPayloadSchema,
  CounterpartyRoleEndResultSchema,
  counterpartyRoleEndAction,
} from '../../src/actions/counterparty-role-end.action.ts';
import {
  counterpartyReadPermissionTarget,
  counterpartyReadRead,
} from '../../src/api/counterparty-read.read.ts';
import {
  counterpartyRoleHistoryPermissionTarget,
  counterpartyRoleHistoryRead,
} from '../../src/api/counterparty-role-history.read.ts';
import {
  CounterpartyReadRequestSchema,
  CounterpartyReadResponseSchema,
} from '../../shared/apis/counterparty-read.ts';
import {
  CounterpartyRoleHistoryRequestSchema,
  CounterpartyRoleHistoryResponseSchema,
} from '../../shared/apis/counterparty-role-history.ts';
import { OutboxPayloadSchema as CounterpartyCreatedOutboxPayloadSchema } from '../../shared/outbox/party-registry-counterparty-created-v1.ts';
import { OutboxPayloadSchema as CounterpartyRoleAddedOutboxPayloadSchema } from '../../shared/outbox/party-registry-counterparty-role-added-v1.ts';
import { OutboxPayloadSchema as CounterpartyRoleEndedOutboxPayloadSchema } from '../../shared/outbox/party-registry-counterparty-role-ended-v1.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const partyId = '20000000-0000-4000-8000-000000000001';
const legalEntityId = '30000000-0000-4000-8000-000000000001';
const counterpartyId = '40000000-0000-4000-8000-000000000001';
const rolePeriodId = '50000000-0000-4000-8000-000000000001';

const partyRef = {
  moduleId: 'party.registry',
  resourceId: partyId,
  resourceType: 'party.registry.party',
  tenantId,
} as const;
const counterpartyRef = {
  moduleId: 'party.registry',
  resourceId: counterpartyId,
  resourceType: 'party.registry.counterparty',
  tenantId,
} as const;
const rolePeriodRef = {
  moduleId: 'party.registry',
  resourceId: rolePeriodId,
  resourceType: 'party.registry.counterparty-role-period',
  tenantId,
} as const;
const legalEntityRef = {
  moduleId: 'core.identity',
  resourceId: legalEntityId,
  resourceType: 'core.identity.legal-entity',
  tenantId,
} as const;
const provenance = {
  evidenceReference: 'contract:2026-42',
  method: 'SIGNED_CONTRACT',
  reason: 'Signed commercial agreement establishes the context.',
  source: 'contracts.core',
} as const;

test('declares required Legal Entity scope and Counterparty resource authorization', () => {
  assert.deepEqual(
    [counterpartyCreateAction, counterpartyRoleAddAction, counterpartyRoleEndAction].map(
      ({ descriptor }) => ({
        actionKey: descriptor.actionKey,
        idempotency: descriptor.idempotency,
        legalEntityPermission: descriptor.legalEntityPermission,
        legalEntityScope: descriptor.legalEntityScope,
        resourcePermission: descriptor.resourcePermission?.kind,
      }),
    ),
    [
      {
        actionKey: 'party.registry.counterparty-create',
        idempotency: 'required',
        legalEntityPermission: 'manage_counterparty',
        legalEntityScope: 'required',
        resourcePermission: undefined,
      },
      {
        actionKey: 'party.registry.counterparty-role-add',
        idempotency: 'required',
        legalEntityPermission: undefined,
        legalEntityScope: 'required',
        resourcePermission: 'resource',
      },
      {
        actionKey: 'party.registry.counterparty-role-end',
        idempotency: 'required',
        legalEntityPermission: undefined,
        legalEntityScope: 'required',
        resourcePermission: 'resource',
      },
    ],
  );
});

test('creates a durable Counterparty without inventing an implicit role', () => {
  const payload = Schema.decodeUnknownSync(CounterpartyCreatePayloadSchema, {
    onExcessProperty: 'error',
  })({ partyRef, provenance });
  assert.deepEqual(payload, { partyRef, provenance });
  assert.throws(() =>
    Schema.decodeUnknownSync(CounterpartyCreatePayloadSchema, { onExcessProperty: 'error' })({
      partyRef,
      provenance,
      roleType: 'CUSTOMER',
    }),
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(CounterpartyCreatePayloadSchema)({
      partyRef,
      provenance: { method: 'SIGNED_CONTRACT', reason: 'Evidence is mandatory.', source: 'test' },
    }),
  );
  assert.deepEqual(
    Schema.decodeUnknownSync(CounterpartyCreateResultSchema)({
      counterpartyRef,
      created: true,
      legalEntityRef,
      partyRef,
    }),
    { counterpartyRef, created: true, legalEntityRef, partyRef },
  );
});

test('publishes only stable references and bounded lifecycle facts', () => {
  assert.deepEqual(
    Schema.decodeUnknownSync(CounterpartyCreatedOutboxPayloadSchema, {
      onExcessProperty: 'error',
    })({ counterpartyRef, legalEntityRef, partyRef }),
    { counterpartyRef, legalEntityRef, partyRef },
  );
  const added = {
    counterpartyRef,
    rolePeriodRef,
    roleType: 'SUPPLIER' as const,
    validFrom: '2026-09-03T10:00:00.000Z',
    validTo: null,
  };
  assert.deepEqual(
    Schema.decodeUnknownSync(CounterpartyRoleAddedOutboxPayloadSchema)(added),
    added,
  );
  assert.equal(
    Schema.decodeUnknownSync(CounterpartyRoleEndedOutboxPayloadSchema)({
      ...added,
      validTo: '2027-01-31T23:59:59.000Z',
    }).validTo,
    '2027-01-31T23:59:59.000Z',
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(CounterpartyCreatedOutboxPayloadSchema, {
      onExcessProperty: 'error',
    })({ counterpartyRef, displayName: 'ACME', legalEntityRef, partyRef }),
  );
});

test('accepts only CUSTOMER and SUPPLIER role periods with explicit evidence', () => {
  for (const roleType of ['CUSTOMER', 'SUPPLIER'] as const) {
    assert.equal(
      Schema.decodeUnknownSync(CounterpartyRoleAddPayloadSchema)({
        counterpartyRef,
        provenance,
        roleType,
        validFrom: '2026-09-03T10:00:00.000Z',
      }).roleType,
      roleType,
    );
  }
  for (const roleType of ['BUSINESS_PARTNER', 'OTHER']) {
    assert.throws(() =>
      Schema.decodeUnknownSync(CounterpartyRoleAddPayloadSchema)({
        counterpartyRef,
        provenance,
        roleType,
        validFrom: '2026-09-03T10:00:00.000Z',
      }),
    );
  }
  for (const validFrom of ['2026-02-30T00:00:00.000Z', '2026-01-01T00:00:00Z']) {
    assert.throws(() =>
      Schema.decodeUnknownSync(CounterpartyRoleAddPayloadSchema)({
        counterpartyRef,
        provenance,
        roleType: 'CUSTOMER',
        validFrom,
      }),
    );
  }
  assert.deepEqual(
    Schema.decodeUnknownSync(CounterpartyRoleAddResultSchema)({
      counterpartyRef,
      rolePeriodRef,
      roleType: 'CUSTOMER',
      validFrom: '2026-09-03T10:00:00.000Z',
      validTo: null,
    }),
    {
      counterpartyRef,
      rolePeriodRef,
      roleType: 'CUSTOMER',
      validFrom: '2026-09-03T10:00:00.000Z',
      validTo: null,
    },
  );
  assert.equal(
    Schema.decodeUnknownSync(CounterpartyRoleAddPayloadSchema)({
      counterpartyRef,
      provenance: {
        evidenceReference: provenance.evidenceReference,
        method: provenance.method,
        source: provenance.source,
      },
      roleType: 'CUSTOMER',
      validFrom: '2026-09-03T10:00:00.000Z',
    }).provenance.reason,
    undefined,
  );
});

test('ends one named role period without deleting Counterparty history', () => {
  const payload = Schema.decodeUnknownSync(CounterpartyRoleEndPayloadSchema)({
    counterpartyRef,
    provenance,
    rolePeriodRef,
    validTo: '2027-01-31T23:59:59.000Z',
  });
  assert.deepEqual(payload, {
    counterpartyRef,
    provenance,
    rolePeriodRef,
    validTo: '2027-01-31T23:59:59.000Z',
  });
  assert.equal(
    Schema.decodeUnknownSync(CounterpartyRoleEndResultSchema)({
      counterpartyRef,
      rolePeriodRef,
      roleType: 'SUPPLIER',
      validFrom: '2026-09-03T10:00:00.000Z',
      validTo: '2027-01-31T23:59:59.000Z',
    }).validTo,
    '2027-01-31T23:59:59.000Z',
  );
  assert.equal(
    Schema.decodeUnknownSync(CounterpartyRoleEndPayloadSchema)({
      counterpartyRef,
      provenance: {
        evidenceReference: provenance.evidenceReference,
        method: 'CONFIRMED_SUPPLIER_RELATIONSHIP_END',
        source: provenance.source,
      },
      rolePeriodRef,
      validTo: '2027-01-31T23:59:59.000Z',
    }).provenance.reason,
    undefined,
  );
});

test('publishes a minimum Party projection and keeps full role history separate', () => {
  const request = Schema.decodeUnknownSync(CounterpartyReadRequestSchema)({ counterpartyRef });
  assert.deepEqual(request, { counterpartyRef });
  const currentRole = {
    provenance,
    recordedAt: '2026-09-03T10:01:00.000Z',
    rolePeriodRef,
    roleType: 'CUSTOMER',
    state: 'ACTIVE',
    validFrom: '2026-09-03T10:00:00.000Z',
    validTo: null,
  } as const;
  const result = Schema.decodeUnknownSync(CounterpartyReadResponseSchema, {
    onExcessProperty: 'error',
  })({
    counterpartyRef,
    createdAt: '2026-09-03T10:00:00.000Z',
    currentRoles: [currentRole],
    legalEntityRef,
    party: {
      archived: false,
      canonicalPartyRef: partyRef,
      displayName: 'ACME s.r.o.',
      partyType: 'ORGANIZATION',
      storedPartyRef: partyRef,
    },
  });
  assert.equal(result.party.displayName, 'ACME s.r.o.');
  assert.equal(
    Schema.decodeUnknownSync(CounterpartyReadResponseSchema)({
      ...result,
      party: { ...result.party, displayName: null },
    }).party.displayName,
    null,
  );
  assert.deepEqual(
    result.currentRoles.map(({ roleType }) => roleType),
    ['CUSTOMER'],
  );
  assert.deepEqual(
    Schema.decodeUnknownSync(CounterpartyReadResponseSchema)({
      ...result,
      currentRoles: [],
    }).currentRoles,
    [],
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(CounterpartyReadResponseSchema, { onExcessProperty: 'error' })({
      ...result,
      party: { ...result.party, contactPoints: [] },
    }),
  );

  assert.deepEqual(
    Schema.decodeUnknownSync(CounterpartyRoleHistoryRequestSchema)({ counterpartyRef }),
    { counterpartyRef },
  );
  assert.equal(
    Schema.decodeUnknownSync(CounterpartyRoleHistoryResponseSchema)({
      counterpartyRef,
      roles: [{ ...currentRole, state: 'ENDED', validTo: '2027-01-31T23:59:59.000Z' }],
    }).roles[0]?.state,
    'ENDED',
  );
  assert.equal(counterpartyReadRead.descriptor.permissionTarget, 'resource');
  assert.equal(counterpartyRoleHistoryRead.descriptor.permissionTarget, 'resource');
  assert.equal(counterpartyReadRead.descriptor.legalEntityScope, 'optional');
  assert.equal(counterpartyRoleHistoryRead.descriptor.legalEntityScope, 'optional');
  assert.deepEqual(counterpartyReadPermissionTarget({ counterpartyRef }), {
    kind: 'any_of',
    targets: [
      {
        kind: 'resource',
        resource: {
          moduleId: 'party.registry',
          resourceId: counterpartyId,
          resourceType: 'party.registry.counterparty',
        },
      },
      { kind: 'tenant', permission: 'manage_party_identity' },
    ],
  });
  assert.deepEqual(
    counterpartyRoleHistoryPermissionTarget({ counterpartyRef }),
    counterpartyReadPermissionTarget({ counterpartyRef }),
  );
});
