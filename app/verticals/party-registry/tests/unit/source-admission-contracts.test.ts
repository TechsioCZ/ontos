import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  SourcePersonAdmissionRequestSchema,
  SourcePersonAdmissionResponseSchema,
} from '../../shared/apis/source-person-admission.ts';
import { SourceProfileExportResponseSchema } from '../../shared/apis/source-profile-export.ts';
import { SourceCounterpartyAdmissionResponseSchema } from '../../shared/apis/source-counterparty-admission.ts';

const tenantId = 'df710000-0000-4000-8000-000000000001';
const resourceId = 'df720000-0000-4000-8000-000000000001';
const partyRef = { moduleId: 'party.registry', resourceType: 'party.registry.party', resourceId, tenantId };
const sourceReference = {
  source: { issuer: 'internal-fixture', namespace: 'customers', recordType: 'person', routeRef: 'internal-route' },
  recordId: 'record',
  occurrenceId: 'revision',
};

it('admission request locates a real qualified source occurrence without requiring an invented person assertion', () => {
  expect(Schema.decodeUnknownSync(SourcePersonAdmissionRequestSchema)({ partyRef, sourceReference })).toEqual({
    partyRef,
    sourceReference,
  });
  expect(() =>
    Schema.decodeUnknownSync(SourcePersonAdmissionRequestSchema)({
      partyRef,
      sourceReference: { source: sourceReference.source, recordId: 'record' },
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
    outcome: 'AVAILABLE',
    partyRef,
    revision: 1,
    partyType: 'PERSON',
    firstName: 'Declared first',
    lastName: null,
    businessName: null,
    contactPoints: [],
    unsupported: ['ADDRESSES'],
  });
  expect(result).toMatchObject({
    firstName: 'Declared first',
    lastName: null,
    businessName: null,
    contactPoints: [],
    unsupported: ['ADDRESSES'],
  });
  expect(Schema.decodeUnknownSync(SourceProfileExportResponseSchema)({ outcome: 'NOT_AVAILABLE' })).toEqual({
    outcome: 'NOT_AVAILABLE',
  });
});

it('Counterparty customer admission requires actual managed scope, role identity and honest hash revisions', () => {
  const admitted = {
    outcome: 'CUSTOMER_CURRENT',
    counterpartyRef: { ...partyRef, resourceType: 'party.registry.counterparty' },
    partyRef,
    legalEntityRef: { moduleId: 'core.identity', resourceType: 'core.identity.legal-entity', resourceId, tenantId },
    partyRevision: 1,
    counterpartyRevision: 'a'.repeat(64),
    currentCustomerRoleRef: { ...partyRef, resourceType: 'party.registry.counterparty-role-period' },
    currentCustomerRoleRevision: 'b'.repeat(64),
  };
  expect(Schema.decodeUnknownSync(SourceCounterpartyAdmissionResponseSchema)(admitted)).toEqual(admitted);
  expect(() =>
    Schema.decodeUnknownSync(SourceCounterpartyAdmissionResponseSchema)({ ...admitted, counterpartyRevision: 1 }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(SourceCounterpartyAdmissionResponseSchema)({ ...admitted, currentCustomerRoleRef: null }),
  ).toThrow();
});
