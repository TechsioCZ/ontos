// A lease draft, the references of a new stay and the owner's conflict answer, as the form tests use them.
import { Schema } from 'effect';
import { ApplyCommandActionConflictProblemSchema } from '../../shared/apis/apply-command-action.ts';
import type { Occupancy } from '../../shared/apis/records.ts';
import type { DraftReferences } from '../../src/routes/[lang]/najmy/occupancy-draft.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
export const unitRef = {
  moduleId: 'property.portfolio',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'property.portfolio.unit',
  tenantId,
} as const;
export const guestRef = {
  moduleId: 'party.registry',
  resourceId: '77777777-7777-4777-8777-777777777777',
  resourceType: 'party.registry.party',
  tenantId,
} as const;
export const occupancyRef = {
  moduleId: 'property.leasing',
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'property.leasing.occupancy',
  tenantId,
} as const;
export const leaseDraft: Occupancy = {
  contractRef: null,
  customerCounterpartyRef: {
    moduleId: 'party.registry',
    resourceId: '44444444-4444-4444-8444-444444444444',
    resourceType: 'party.registry.counterparty',
    tenantId,
  },
  endDate: null,
  externalBookingCorrelation: null,
  guestPartyRef: null,
  kind: 'LONG_TERM_LEASE',
  note: null,
  occupancyRef,
  peopleCount: null,
  rentTerms: { currency: 'CZK', monthlyRentMinor: 1_850_000, paymentDay: 15, serviceChargesMinor: 0 },
  startDate: '2026-12-01',
  state: 'DRAFT',
  unitRef,
};
export const references: DraftReferences = { customers: [], guests: [{ ref: guestRef }], units: [{ unitRef }] };
export const conflictProblem = Schema.decodeUnknownSync(ApplyCommandActionConflictProblemSchema)({
  _tag: 'ApplyCommandActionConflictProblem',
  code: 'occupancy_conflict',
  detail: 'Nájmy se mezitím změnily.',
  status: 409,
  title: 'Konflikt',
  type: 'about:blank',
});
