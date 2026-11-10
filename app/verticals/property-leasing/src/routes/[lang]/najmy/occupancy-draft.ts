// What the lease and stay form sends: a new lease, a new stay, or the changed lease draft. Pure, so the form and its
// tests share one definition of the commands.
import { Option, Schema } from 'effect';
import type { OccupancyCommand } from '../../../../shared/actions/apply-command.ts';
import { RentTermsSchema } from '../../../../shared/apis/records.ts';
import type { Occupancy, RecordsResponse, RentTerms } from '../../../../shared/apis/records.ts';
import type { OccupancyDraft } from './editor-state.ts';
import { parseCrowns } from './lease-story.tsx';

type MutableOccupancy = { -readonly [Key in keyof Occupancy]: Occupancy[Key] };
type UpdateDraft = Extract<OccupancyCommand, { readonly _tag: 'UpdateDraft' }>;
type MutableUpdateDraft = { -readonly [Key in keyof UpdateDraft]: UpdateDraft[Key] };

/** The agreed rent the form holds: none while both amounts are empty, `invalid` while a field is not an amount. */
export const rentTermsOfDraft = (draft: OccupancyDraft): RentTerms | 'invalid' | undefined => {
  if (draft.rentMonthly.trim().length === 0 && draft.rentService.trim().length === 0) {
    return undefined;
  }
  const monthlyRentMinor = parseCrowns(draft.rentMonthly);
  const serviceChargesMinor = draft.rentService.trim().length === 0 ? 0 : parseCrowns(draft.rentService);
  const paymentDay = Number(draft.rentPaymentDay);
  if (
    monthlyRentMinor === undefined ||
    serviceChargesMinor === undefined ||
    !Number.isInteger(paymentDay) ||
    paymentDay < 1 ||
    paymentDay > 31
  ) {
    return 'invalid';
  }
  return { currency: 'CZK', monthlyRentMinor, paymentDay, serviceChargesMinor };
};

/** What a new lease or stay refers to, as the page read it. */
export interface DraftReferences {
  readonly customers: readonly { readonly counterpartyRef: NonNullable<Occupancy['customerCounterpartyRef']> }[];
  readonly guests: readonly { readonly ref: NonNullable<Occupancy['guestPartyRef']> }[];
  readonly units: readonly { readonly unitRef: Occupancy['unitRef'] }[];
}

const occupancyRefOf = (
  unit: { readonly unitRef: Occupancy['unitRef'] },
  resourceId: string,
): Occupancy['occupancyRef'] => ({
  moduleId: 'property.leasing',
  resourceId,
  resourceType: 'property.leasing.occupancy',
  tenantId: unit.unitRef.tenantId,
});

/** The record of a new lease draft; None while the unit, the tenant or the rent is missing or invalid. */
export const leaseDraftRecord = (
  draft: OccupancyDraft,
  references: DraftReferences,
  resourceId: string,
): Option.Option<Occupancy> => {
  const unit = references.units.find((record) => record.unitRef.resourceId === draft.unitId);
  const customer = references.customers.find((record) => record.counterpartyRef.resourceId === draft.customerId);
  const rentTerms = rentTermsOfDraft(draft);
  if (unit === undefined || customer === undefined || rentTerms === 'invalid') {
    return Option.none();
  }
  const record: MutableOccupancy = {
    contractRef: null,
    customerCounterpartyRef: customer.counterpartyRef,
    endDate: draft.endDate || null,
    externalBookingCorrelation: null,
    guestPartyRef: null,
    kind: 'LONG_TERM_LEASE',
    note: null,
    occupancyRef: occupancyRefOf(unit, resourceId),
    peopleCount: null,
    startDate: draft.startDate,
    state: 'DRAFT',
    unitRef: unit.unitRef,
  };
  if (rentTerms !== undefined) {
    record.rentTerms = rentTerms;
  }
  return Option.some(record);
};

/** The record of a new stay; None while the unit, guest, people count, period or note is missing or invalid. */
export const stayDraftRecord = (
  draft: OccupancyDraft,
  references: DraftReferences,
  resourceId: string,
): Option.Option<Occupancy> => {
  const unit = references.units.find((item) => item.unitRef.resourceId === draft.unitId);
  const guest = references.guests.find((item) => item.ref.resourceId === draft.guestId);
  const count = Number(draft.peopleCount);
  if (
    unit === undefined ||
    guest === undefined ||
    !Number.isInteger(count) ||
    count < 1 ||
    draft.endDate.length === 0 ||
    draft.endDate <= draft.startDate ||
    draft.stayNote.length > 500
  ) {
    return Option.none();
  }
  return Option.some({
    contractRef: null,
    customerCounterpartyRef: null,
    endDate: draft.endDate,
    externalBookingCorrelation: null,
    guestPartyRef: guest.ref,
    kind: 'SHORT_STAY',
    note: draft.stayNote.trim() || null,
    occupancyRef: occupancyRefOf(unit, resourceId),
    peopleCount: count,
    startDate: draft.startDate,
    state: 'DRAFT',
    unitRef: unit.unitRef,
  });
};

/** The change of a lease draft: its period and rent as typed; None while the rent is invalid. */
export const updateDraftCommand = (
  occupancyRef: Occupancy['occupancyRef'],
  draft: OccupancyDraft,
): Option.Option<OccupancyCommand> => {
  const rentTerms = rentTermsOfDraft(draft);
  if (rentTerms === 'invalid') {
    return Option.none();
  }
  const command: MutableUpdateDraft = {
    _tag: 'UpdateDraft',
    endDate: draft.endDate || null,
    occupancyRef,
    startDate: draft.startDate,
  };
  if (rentTerms !== undefined) {
    command.rentTerms = rentTerms;
  }
  return Option.some(command);
};

const sameRent = Schema.toEquivalence(RentTermsSchema);

/**
 * Whether fresh records still hold the lease draft as the form's last confirmed version: still a draft, with the
 * period and rent the form opened with or last saved. Anything else is someone else's change and stays a conflict.
 */
export const draftUnchangedSince =
  (resourceId: string, confirmed: OccupancyDraft) =>
  (records: RecordsResponse): boolean => {
    const current = records.occupancies.find((item) => item.occupancyRef.resourceId === resourceId);
    const rentTerms = rentTermsOfDraft(confirmed);
    if (current?.state !== 'DRAFT' || rentTerms === 'invalid') {
      return false;
    }
    const sameTerms =
      current.rentTerms === undefined || rentTerms === undefined
        ? current.rentTerms === rentTerms
        : sameRent(current.rentTerms, rentTerms);
    return current.startDate === confirmed.startDate && (current.endDate ?? '') === confirmed.endDate && sameTerms;
  };
