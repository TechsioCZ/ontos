import { Option } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import {
  initialEditorState,
  occupancyEditorActions,
  occupancyEditorReducer,
} from '../../src/routes/[lang]/najmy/editor-state.ts';
import type { Occupancy } from '../../shared/apis/records.ts';

const today = '2026-10-27';
const tenantId = '11111111-1111-4111-8111-111111111111';
const openLease = occupancyEditorActions.OPEN_DRAFT({
  initialUnitId: 'unit-from-link',
  mode: 'lease',
  startDate: today,
});
const previousEditor = {
  ...initialEditorState('2026-01-01'),
  customerId: 'previous-customer',
  customerOpen: true,
  editingId: 'previous-draft',
  endDate: '2026-01-31',
  guestId: 'previous-guest',
  guestQuery: 'previous query',
  peopleCount: '8',
  rentEditorOpen: true,
  rentMonthly: '12000',
  rentPaymentDay: '20',
  rentService: '1500',
  stayNote: 'Previous stay',
  unitId: 'previous-unit',
};

describe('occupancy editor transitions', () => {
  it('opens a linked lease atomically after its unit arrives and clears the previous draft inputs', () => {
    const opened = occupancyEditorReducer(previousEditor, openLease);
    expect(Option.getOrNull(opened.editor)).toBe('lease');
    expect(opened).toMatchObject({
      customerId: '',
      customerOpen: true,
      customersLoading: true,
      editingId: '',
      endDate: '',
      guestId: '',
      guestQuery: '',
      peopleCount: '2',
      rentEditorOpen: true,
      rentMonthly: '',
      rentPaymentDay: '15',
      rentService: '',
      startDate: today,
      stayNote: '',
      unitId: 'unit-from-link',
    });
    const stay = occupancyEditorReducer(
      initialEditorState(today),
      occupancyEditorActions.OPEN_DRAFT({ initialUnitId: '', mode: 'stay', startDate: today }),
    );
    expect(Option.getOrNull(stay.editor)).toBe('stay');
    expect(stay.customersLoading).toBe(false);
  });

  it('keeps edits made while customer options load when that asynchronous read completes', () => {
    const opened = occupancyEditorReducer(initialEditorState(today), openLease);
    const edited = occupancyEditorReducer(
      opened,
      occupancyEditorActions.SET_INPUT({ field: 'startDate', value: '2026-11-01' }),
    );
    const loaded = occupancyEditorReducer(edited, occupancyEditorActions.CUSTOMERS_LOADED({ customers: [] }));
    const settled = occupancyEditorReducer(loaded, occupancyEditorActions.CUSTOMERS_LOADING({ loading: false }));
    expect(settled.startDate).toBe('2026-11-01');
    expect(settled.unitId).toBe('unit-from-link');
    expect(Option.getOrNull(settled.editor)).toBe('lease');
    expect(settled.customersLoading).toBe(false);
  });

  it('opens rent editing without resetting the draft and copies a selected draft interval together', () => {
    const opened = occupancyEditorReducer(
      previousEditor,
      occupancyEditorActions.OPEN_RENT({
        terms: Option.some({
          currency: 'CZK',
          monthlyRentMinor: 1_234_500,
          paymentDay: 7,
          serviceChargesMinor: 250_000,
        }),
      }),
    );
    expect(opened).toMatchObject({
      editingId: 'previous-draft',
      rentEditorOpen: true,
      rentMonthly: '12345',
      rentPaymentDay: '7',
      rentService: '2500',
      unitId: 'previous-unit',
    });
    const record: Occupancy = {
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
      occupancyRef: {
        moduleId: 'property.leasing',
        resourceId: '55555555-5555-4555-8555-555555555555',
        resourceType: 'property.leasing.occupancy',
        tenantId,
      },
      peopleCount: null,
      startDate: '2026-12-01',
      state: 'DRAFT',
      unitRef: {
        moduleId: 'property.portfolio',
        resourceId: '33333333-3333-4333-8333-333333333333',
        resourceType: 'property.portfolio.unit',
        tenantId,
      },
    };
    const draft = occupancyEditorReducer(opened, occupancyEditorActions.EDIT_DRAFT({ record }));
    expect(Option.getOrNull(draft.editor)).toBe('lease');
    expect(draft).toMatchObject({
      editingId: record.occupancyRef.resourceId,
      endDate: '',
      rentMonthly: '',
      rentPaymentDay: '15',
      rentService: '',
      startDate: record.startDate,
    });
  });

  it('clears identities and dialogs on a revoked read while retaining the existing reset policy', () => {
    const cleared = occupancyEditorReducer(previousEditor, occupancyEditorActions.CLEAR({ startDate: today }));
    expect(Option.isNone(cleared.editor)).toBe(true);
    expect(cleared).toMatchObject({
      customerId: '',
      customerOpen: false,
      customers: [],
      customersLoading: false,
      editingId: '',
      endDate: '',
      guestId: '',
      guestQuery: '',
      guests: [],
      rentEditorOpen: false,
      startDate: today,
      unitId: '',
    });
    expect(cleared.peopleCount).toBe(previousEditor.peopleCount);
    expect(cleared.stayNote).toBe(previousEditor.stayNote);
    expect(cleared.rentMonthly).toBe(previousEditor.rentMonthly);
  });
});
