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
  customerOpen: true,
  editingId: 'previous-draft',
  opened: {
    customerId: 'previous-customer',
    endDate: '2026-01-31',
    guestId: 'previous-guest',
    peopleCount: '8',
    rentMonthly: '12000',
    rentPaymentDay: '20',
    rentService: '1500',
    startDate: '2026-01-01',
    stayNote: 'Previous stay',
    unitId: 'previous-unit',
  },
  rentEditorOpen: true,
};

describe('occupancy editor transitions', () => {
  it('opens a linked lease atomically after its unit arrives and clears the previous draft inputs', () => {
    const opened = occupancyEditorReducer(previousEditor, openLease);
    expect(Option.getOrNull(opened.editor)).toBe('lease');
    expect(opened).toMatchObject({
      customerOpen: true,
      customersLoading: true,
      editingId: '',
      opened: {
        customerId: '',
        endDate: '',
        guestId: '',
        peopleCount: '2',
        rentMonthly: '',
        rentPaymentDay: '15',
        rentService: '',
        startDate: today,
        stayNote: '',
        unitId: 'unit-from-link',
      },
      rentEditorOpen: true,
    });
    const stay = occupancyEditorReducer(
      initialEditorState(today),
      occupancyEditorActions.OPEN_DRAFT({ initialUnitId: '', mode: 'stay', startDate: today }),
    );
    expect(Option.getOrNull(stay.editor)).toBe('stay');
    expect(stay.customersLoading).toBe(false);
  });

  it('keeps the opened form when its customer options load', () => {
    const opened = occupancyEditorReducer(initialEditorState(today), openLease);
    const loaded = occupancyEditorReducer(opened, occupancyEditorActions.CUSTOMERS_LOADED({ customers: [] }));
    const settled = occupancyEditorReducer(loaded, occupancyEditorActions.CUSTOMERS_LOADING({ loading: false }));
    expect(settled.opened).toEqual(opened.opened);
    expect(Option.getOrNull(settled.editor)).toBe('lease');
    expect(settled.customersLoading).toBe(false);
  });

  it('opens rent editing without resetting the draft and opens a selected draft with its interval and rent', () => {
    const rent = occupancyEditorReducer(previousEditor, occupancyEditorActions.SET_RENT_EDITOR_OPEN({ open: true }));
    expect(rent).toMatchObject({ editingId: 'previous-draft', opened: previousEditor.opened, rentEditorOpen: true });
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
    const draft = occupancyEditorReducer(rent, occupancyEditorActions.EDIT_DRAFT({ record }));
    expect(Option.getOrNull(draft.editor)).toBe('lease');
    expect(draft).toMatchObject({
      editingId: record.occupancyRef.resourceId,
      opened: { endDate: '', rentMonthly: '', rentPaymentDay: '15', rentService: '', startDate: record.startDate },
    });
  });

  it('clears identities and dialogs on a revoked read while retaining the existing reset policy', () => {
    const cleared = occupancyEditorReducer(previousEditor, occupancyEditorActions.CLEAR({ startDate: today }));
    expect(Option.isNone(cleared.editor)).toBe(true);
    expect(cleared).toMatchObject({
      customerOpen: false,
      customers: [],
      customersLoading: false,
      editingId: '',
      guests: [],
      opened: { customerId: '', endDate: '', guestId: '', startDate: today, unitId: '' },
      rentEditorOpen: false,
    });
    expect(cleared.opened.peopleCount).toBe(previousEditor.opened.peopleCount);
    expect(cleared.opened.stayNote).toBe(previousEditor.opened.stayNote);
    expect(cleared.opened.rentMonthly).toBe(previousEditor.opened.rentMonthly);
  });
});
