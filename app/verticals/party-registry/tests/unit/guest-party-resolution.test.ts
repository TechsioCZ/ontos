import { expect, it } from 'effect-rstest';

import { classifyGuestPartyResolution } from '../../src/services/guest-party-resolution.service.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const partyId = '20000000-0000-4000-8000-000000000002';

const party = (partyType: 'ORGANIZATION' | 'PERSON' | 'UNRESOLVED' = 'PERSON') => ({
  archived: false,
  partyId,
  partyType,
});

const base = {
  cases: [],
  partyIds: [partyId],
  parties: [party()],
  tenantId,
} as const;

it('returns an existing owner only for a single active Party identity', () => {
  expect(classifyGuestPartyResolution(base)).toEqual({
    outcome: 'EXISTING_PARTY_RESOLVED',
    partyRef: {
      moduleId: 'party.registry',
      resourceId: partyId,
      resourceType: 'party.registry.party',
      tenantId,
    },
  });
});

it('keeps unresolved Party ownership typed instead of asking CCC to infer it', () => {
  expect(classifyGuestPartyResolution({ ...base, parties: [party('UNRESOLVED')] })).toEqual({
    outcome: 'UNRESOLVED_PARTY_CREATED',
    partyRef: {
      moduleId: 'party.registry',
      resourceId: partyId,
      resourceType: 'party.registry.party',
      tenantId,
    },
  });
});

it('returns a scoped review case when owner evidence is still ambiguous', () => {
  expect(
    classifyGuestPartyResolution({
      ...base,
      cases: [
        {
          caseId: '30000000-0000-4000-8000-000000000003',
          lifecycleState: 'OPEN',
          resolutionOutcome: null,
          selectedPartyId: null,
        },
      ],
    }),
  ).toEqual({
    caseRef: {
      moduleId: 'party.registry',
      resourceId: '30000000-0000-4000-8000-000000000003',
      resourceType: 'party.registry.duplicate-candidate-case',
      tenantId,
    },
    outcome: 'AMBIGUOUS_MATCH',
  });
});

it('fails closed when accepted evidence points at competing or unavailable owners', () => {
  expect(
    classifyGuestPartyResolution({
      ...base,
      partyIds: [partyId, '40000000-0000-4000-8000-000000000004'],
    }),
  ).toEqual({ outcome: 'PARTY_OWNER_INDETERMINATE', retryable: true });
  expect(
    classifyGuestPartyResolution({
      ...base,
      parties: [],
    }),
  ).toEqual({ outcome: 'PARTY_OWNER_INDETERMINATE', retryable: true });
  expect(
    classifyGuestPartyResolution({
      ...base,
      cases: [
        {
          caseId: '30000000-0000-4000-8000-000000000003',
          lifecycleState: 'OPEN',
          resolutionOutcome: null,
          selectedPartyId: null,
        },
        {
          caseId: '50000000-0000-4000-8000-000000000005',
          lifecycleState: 'NEEDS_EVIDENCE',
          resolutionOutcome: null,
          selectedPartyId: null,
        },
      ],
    }),
  ).toEqual({ outcome: 'PARTY_OWNER_INDETERMINATE', retryable: true });
});

it('does not resolve archived or identity-free evidence into a Party owner', () => {
  expect(
    classifyGuestPartyResolution({
      ...base,
      parties: [{ ...party(), archived: true }],
    }),
  ).toEqual({
    outcome: 'INVALID_OR_INSUFFICIENT_EVIDENCE',
    reason: 'Guest evidence identifies an archived Party',
  });
  expect(
    classifyGuestPartyResolution({
      ...base,
      partyIds: [],
      parties: [],
    }),
  ).toEqual({
    outcome: 'INVALID_OR_INSUFFICIENT_EVIDENCE',
    reason: 'Guest evidence does not establish a Party identity',
  });
});
