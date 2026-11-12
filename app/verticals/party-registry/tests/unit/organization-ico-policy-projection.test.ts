import { OrganizationIcoApplicabilityResponseSchema } from '@app/privacy/api';
import { Schema } from 'effect';
import { assert, expect, it } from 'effect-rstest';
import {
  OrganizationIcoFieldContractVersion,
  OrganizationIcoProjectionFields,
} from '../../shared/apis/organization-ico-facts.ts';
import { organizationIcoDecisionMatchesFacts } from '../../src/services/legacy-ico-privacy.service.ts';

const tenantId = 'df940000-0000-4000-8000-000000000001';
const partyId = 'df950000-0000-4000-8000-000000000001';
const current = Schema.decodeUnknownSync(OrganizationIcoApplicabilityResponseSchema)({
  outcome: 'NOT_APPLICABLE',
  partyRef: { moduleId: 'party.registry', resourceType: 'party.registry.party', resourceId: partyId, tenantId },
  partyRevision: 5,
  fieldContractVersion: OrganizationIcoFieldContractVersion,
  allowedFields: OrganizationIcoProjectionFields,
  applicabilityDecisionRef: 'internal-fixture:decision',
  authorityIncarnation: 'internal-fixture:incarnation',
  authorityRevision: '1',
  evaluatedAt: '2026-11-07T00:00:00.000Z',
  evidenceRefs: ['internal-fixture:evidence'],
  policyRevisions: [{ policyRef: 'internal-fixture:policy', revision: '1' }],
});

it('requires explicit current NOT_APPLICABLE for the exact ORG fact version and every fixed safe field', () => {
  expect(organizationIcoDecisionMatchesFacts(current, tenantId, { partyId, partyRevision: 5 })).toBe(true);
  expect(organizationIcoDecisionMatchesFacts(current, tenantId, { partyId, partyRevision: 6 })).toBe(false);
  expect(
    organizationIcoDecisionMatchesFacts(current, tenantId, {
      partyId: 'df950000-0000-4000-8000-000000000002',
      partyRevision: 5,
    }),
  ).toBe(false);
  expect(
    organizationIcoDecisionMatchesFacts(current, 'df940000-0000-4000-8000-000000000002', { partyId, partyRevision: 5 }),
  ).toBe(false);
  assert.isOk(current.outcome === 'NOT_APPLICABLE');
  expect(
    organizationIcoDecisionMatchesFacts({ ...current, allowedFields: current.allowedFields.slice(1) }, tenantId, {
      partyId,
      partyRevision: 5,
    }),
  ).toBe(false);
});

it('never substitutes an organization classification for denied or indeterminate native policy', () => {
  for (const outcome of ['DENIED', 'INDETERMINATE']) {
    const denied = Schema.decodeUnknownSync(OrganizationIcoApplicabilityResponseSchema)({
      outcome,
      reason: 'internal-fixture:no-current-policy',
      evaluatedAt: '2026-11-07T00:00:00.000Z',
    });
    expect(organizationIcoDecisionMatchesFacts(denied, tenantId, { partyId, partyRevision: 5 })).toBe(false);
  }
});
