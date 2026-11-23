import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  SourcePersonAdmissionRequestSchema,
  SourcePersonAdmissionResponseSchema,
} from '../../shared/apis/source-person-admission.ts';
import { SourceProfileExportResponseSchema } from '../../shared/apis/source-profile-export.ts';
import { SourceCounterpartyAdmissionResponseSchema } from '../../shared/apis/source-counterparty-admission.ts';

import { sourceCounterpartyAdmissionRead } from '../../src/api/source-counterparty-admission.read.ts';

const tenantId = 'df710000-0000-4000-8000-000000000001';
const resourceId = 'df720000-0000-4000-8000-000000000001';
const partyRef = { moduleId: 'party.registry', resourceId, resourceType: 'party.registry.party', tenantId };
const sourceReference = {
  occurrenceId: 'revision',
  recordId: 'record',
  source: { issuer: 'internal-fixture', namespace: 'customers', recordType: 'person', routeRef: 'internal-route' },
};

it('admission request locates a real qualified source occurrence without requiring an invented person assertion', () => {
  expect(Schema.decodeUnknownSync(SourcePersonAdmissionRequestSchema)({ partyRef, sourceReference })).toEqual({
    partyRef,
    sourceReference,
  });
  expect(() =>
    Schema.decodeUnknownSync(SourcePersonAdmissionRequestSchema)({
      partyRef,
      sourceReference: { recordId: 'record', source: sourceReference.source },
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(SourcePersonAdmissionResponseSchema)({
      outcome: 'SOURCE_PERSON_CURRENT',
      partyRef,
      partyRevision: 1,
    }),
  ).toThrow();
});

it('profile exports preserve unknown structured values and expose unsupported address scope explicitly', () => {
  const result = Schema.decodeUnknownSync(SourceProfileExportResponseSchema)({
    businessName: null,
    contactPoints: [],
    firstName: 'Declared first',
    lastName: null,
    outcome: 'AVAILABLE',
    partyRef,
    partyType: 'PERSON',
    revision: 1,
    unsupported: ['ADDRESSES'],
  });
  expect(result).toMatchObject({
    businessName: null,
    contactPoints: [],
    firstName: 'Declared first',
    lastName: null,
    unsupported: ['ADDRESSES'],
  });
  expect(Schema.decodeUnknownSync(SourceProfileExportResponseSchema)({ outcome: 'NOT_AVAILABLE' })).toEqual({
    outcome: 'NOT_AVAILABLE',
  });
});

it('Counterparty customer admission requires actual managed scope, role identity and honest hash revisions', () => {
  const admitted = {
    counterpartyRef: { ...partyRef, resourceType: 'party.registry.counterparty' },
    counterpartyRevision: 'a'.repeat(64),
    currentCustomerRoleRef: { ...partyRef, resourceType: 'party.registry.counterparty-role-period' },
    currentCustomerRoleRevision: 'b'.repeat(64),
    legalEntityRef: { moduleId: 'core.identity', resourceId, resourceType: 'core.identity.legal-entity', tenantId },
    outcome: 'CUSTOMER_CURRENT',
    partyRef,
    partyRevision: 1,
  };
  expect(Schema.decodeUnknownSync(SourceCounterpartyAdmissionResponseSchema)(admitted)).toEqual(admitted);
  expect(() =>
    Schema.decodeUnknownSync(SourceCounterpartyAdmissionResponseSchema)({ ...admitted, counterpartyRevision: 1 }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(SourceCounterpartyAdmissionResponseSchema)({ ...admitted, currentCustomerRoleRef: null }),
  ).toThrow();
});

it('admits only the commerce customer context actor for the source counterparty workload', () => {
  const { accessActor, accessWorkload, legalEntityScope } = sourceCounterpartyAdmissionRead.descriptor;
  expect(accessActor).toMatchObject({
    callers: ['commerce-customer-context'],
    subject: 'rights',
    subjectWorkloads: ['party.registry.source-read'],
  });
  expect(accessWorkload?.workloads).toEqual(['party.registry.source-read']);
  expect(legalEntityScope).toBe('required');
});
