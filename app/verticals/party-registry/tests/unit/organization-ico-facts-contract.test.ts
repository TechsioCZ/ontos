import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  OrganizationIcoFactsRequestSchema,
  OrganizationIcoFactsResponseSchema,
  OrganizationIcoFieldContractVersion,
  OrganizationIcoProjectionFields,
} from '../../shared/apis/organization-ico-facts.ts';

const partyRef = {
  moduleId: 'party.registry',
  resourceType: 'party.registry.party',
  resourceId: 'df910000-0000-4000-8000-000000000001',
  tenantId: 'df920000-0000-4000-8000-000000000001',
};

it('requires the frozen ICO business-field contract and truthful owner revision metadata', () => {
  const request = { partyRef, fieldContractVersion: OrganizationIcoFieldContractVersion, expectedPartyRevision: 7 };
  expect(Schema.decodeUnknownSync(OrganizationIcoFactsRequestSchema)(request)).toEqual(request);
  expect(() =>
    Schema.decodeUnknownSync(OrganizationIcoFactsRequestSchema)({ ...request, fieldContractVersion: 'other' }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(OrganizationIcoFactsRequestSchema)({ ...request, expectedPartyRevision: 0 }),
  ).toThrow();
});

it('bounds the classification proof to the frozen safe projection and actual current type assertion', () => {
  const result = {
    outcome: 'CURRENT_ORGANIZATION',
    fieldContractVersion: OrganizationIcoFieldContractVersion,
    partyRef,
    partyRevision: 7,
    typeAssertionId: partyRef.resourceId,
    typeAssertionValidFrom: '2020-01-01T00:00:00.000Z',
    typeAssertionValidTo: null,
    typeAssertionRecordedAt: '2020-01-02T00:00:00.000Z',
    typeAssertionState: 'ACTIVE',
    typeAssertionIsCurrent: true,
    allowedFields: OrganizationIcoProjectionFields,
  };
  expect(Schema.decodeUnknownSync(OrganizationIcoFactsResponseSchema)(result)).toEqual(result);
  expect(() =>
    Schema.decodeUnknownSync(OrganizationIcoFactsResponseSchema)({
      ...result,
      allowedFields: [...OrganizationIcoProjectionFields, 'provenance.acceptedByPrincipalId'],
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(OrganizationIcoFactsResponseSchema)({ ...result, typeAssertionIsCurrent: false }),
  ).toThrow();
});
