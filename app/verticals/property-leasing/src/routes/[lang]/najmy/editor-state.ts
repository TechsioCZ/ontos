import { Data, Match, Option } from 'effect';
import type { Effect, Schema } from 'effect';
import type { findCustomers, listCustomers } from './party-customers.ts';
import type { Occupancy, OccupancySchema, RentTerms } from '../../../../shared/apis/records.ts';
import { crownsInput } from './lease-story.tsx';

type OccupancyWire = Schema.Codec.Encoded<typeof OccupancySchema>;

interface EditorInputs {
  readonly customerId: string;
  readonly editingId: string;
  readonly endDate: NonNullable<OccupancyWire['endDate']>;
  readonly guestId: string;
  readonly guestQuery: string;
  readonly peopleCount: string;
  readonly rentMonthly: string;
  readonly rentPaymentDay: string;
  readonly rentService: string;
  readonly startDate: OccupancyWire['startDate'];
  readonly stayNote: string;
  readonly unitId: string;
}
/**
 * What the Save button of the lease or stay form sends from: every typed field of the form. The guest search box is
 * not part of it; it only looks parties up.
 */
export type OccupancyDraft = Omit<EditorInputs, 'editingId' | 'guestQuery'>;

/** The draft of an editor state. */
export const occupancyDraftOf = (state: EditorInputs): OccupancyDraft => ({
  customerId: state.customerId,
  endDate: state.endDate,
  guestId: state.guestId,
  peopleCount: state.peopleCount,
  rentMonthly: state.rentMonthly,
  rentPaymentDay: state.rentPaymentDay,
  rentService: state.rentService,
  startDate: state.startDate,
  stayNote: state.stayNote,
  unitId: state.unitId,
});

type Guest = Effect.Success<ReturnType<typeof findCustomers>>[number];

export interface OccupancyEditorState extends EditorInputs {
  readonly customerOpen: boolean;
  readonly customers: Effect.Success<ReturnType<typeof listCustomers>>;
  readonly customersLoading: boolean;
  readonly editor: Option.Option<'lease' | 'stay'>;
  /**
   * The guest the person chose. The form owns it: a later guest search only offers others, so the guest stays chosen
   * until the person picks another one or clears it, or a refused read clears the whole form.
   */
  readonly guest: Option.Option<Guest>;
  /** What the latest guest search found. */
  readonly guests: readonly Guest[];
  /** The latest guest search failed for now; the stay form says so next to the guest picker. */
  readonly guestSearchFailed: boolean;
  readonly rentEditorOpen: boolean;
}
export type OccupancyEditorMode = Option.Option.Value<OccupancyEditorState['editor']>;
export type OccupancyEditorAction = Data.TaggedEnum<{
  CLEAR: { readonly startDate: EditorInputs['startDate'] };
  CUSTOMERS_LOADED: { readonly customers: OccupancyEditorState['customers'] };
  CUSTOMERS_LOADING: { readonly loading: boolean };
  EDIT_DRAFT: { readonly record: Occupancy };
  /** The guest search failed for now: no earlier hit stays on offer, the chosen guest stays. */
  GUEST_SEARCH_FAILED: Readonly<Record<never, never>>;
  GUESTS_LOADED: { readonly guests: OccupancyEditorState['guests'] };
  OPEN_DRAFT: {
    readonly initialUnitId: string;
    readonly mode: OccupancyEditorMode;
    readonly startDate: EditorInputs['startDate'];
  };
  OPEN_RENT: { readonly terms: Option.Option<RentTerms> };
  /** "Zahodit změny" or "Načíst aktuální verzi": the form shows `draft` again. */
  RESTORE_DRAFT: { readonly draft: OccupancyDraft };
  SET_CUSTOMER_OPEN: { readonly open: boolean };
  SET_EDITOR: { readonly mode: OccupancyEditorState['editor'] };
  SET_INPUT: { readonly field: keyof EditorInputs; readonly value: string };
  SET_RENT_EDITOR_OPEN: { readonly open: boolean };
}>;
export const occupancyEditorActions = Data.taggedEnum<OccupancyEditorAction>();

export const initialEditorState = (startDate: EditorInputs['startDate']): OccupancyEditorState => ({
  customerId: '',
  customerOpen: false,
  customers: [],
  customersLoading: false,
  editingId: '',
  editor: Option.none(),
  endDate: '',
  guest: Option.none(),
  guestId: '',
  guestQuery: '',
  guests: [],
  guestSearchFailed: false,
  peopleCount: '2',
  rentEditorOpen: false,
  rentMonthly: '',
  rentPaymentDay: '15',
  rentService: '',
  startDate,
  stayNote: '',
  unitId: '',
});
const rentInputs = (terms: Option.Option<RentTerms>) =>
  Option.match(terms, {
    onNone: () => ({ rentMonthly: '', rentPaymentDay: '15', rentService: '' }),
    onSome: (value) => ({
      rentMonthly: crownsInput(value.monthlyRentMinor),
      rentPaymentDay: String(value.paymentDay),
      rentService: crownsInput(value.serviceChargesMinor),
    }),
  });

/** A lease draft's form fields as `record` holds them; the other fields of `draft` stay. */
export const withRecordInputs = (draft: OccupancyDraft, record: Occupancy): OccupancyDraft => ({
  ...draft,
  ...rentInputs(Option.fromUndefinedOr(record.rentTerms)),
  endDate: record.endDate ?? '',
  startDate: record.startDate,
});

/**
 * The guests the stay form offers: the latest search's hits plus the chosen guest they omit. The picker treats them as
 * its complete collection.
 */
export const guestChoicesOf = (state: OccupancyEditorState): readonly Guest[] =>
  state.guest.pipe(
    Option.filter(
      (chosen) =>
        chosen.partyRef.resourceId === state.guestId &&
        !state.guests.some((item) => item.partyRef.resourceId === chosen.partyRef.resourceId),
    ),
    Option.match({ onNone: () => state.guests, onSome: (chosen) => [chosen, ...state.guests] }),
  );

/** One transition owns the related dialog fields; filters and records remain outside the editor. */
export const occupancyEditorReducer = (
  state: OccupancyEditorState,
  action: OccupancyEditorAction,
): OccupancyEditorState =>
  Match.value(action).pipe(
    Match.tagsExhaustive({
      CLEAR: ({ startDate }) => ({
        ...state,
        customerId: '',
        customerOpen: false,
        customers: [],
        customersLoading: false,
        editingId: '',
        editor: Option.none(),
        endDate: '',
        guest: Option.none(),
        guestId: '',
        guestQuery: '',
        guests: [],
        guestSearchFailed: false,
        rentEditorOpen: false,
        startDate,
        unitId: '',
      }),
      CUSTOMERS_LOADED: ({ customers }) => ({ ...state, customers }),
      CUSTOMERS_LOADING: ({ loading }) => ({ ...state, customersLoading: loading }),
      EDIT_DRAFT: ({ record }) => ({
        ...state,
        ...rentInputs(Option.fromUndefinedOr(record.rentTerms)),
        editingId: record.occupancyRef.resourceId,
        editor: Option.some<OccupancyEditorMode>('lease'),
        endDate: record.endDate ?? '',
        startDate: record.startDate,
      }),
      GUEST_SEARCH_FAILED: () => ({ ...state, guests: [], guestSearchFailed: true }),
      // A newer answer about the chosen guest replaces the kept one, so a later search that omits the guest still
      // shows the current name.
      GUESTS_LOADED: ({ guests }) => ({
        ...state,
        guest: state.guest.pipe(
          Option.map(
            (chosen) => guests.find((item) => item.partyRef.resourceId === chosen.partyRef.resourceId) ?? chosen,
          ),
        ),
        guests,
        guestSearchFailed: false,
      }),
      OPEN_DRAFT: ({ initialUnitId, mode, startDate }) => ({
        ...state,
        customerId: '',
        customers: [],
        customersLoading: mode === 'lease' || state.customersLoading,
        editingId: '',
        editor: Option.some(mode),
        endDate: '',
        guest: Option.none(),
        guestId: '',
        guestQuery: '',
        guests: [],
        guestSearchFailed: false,
        peopleCount: '2',
        rentMonthly: '',
        rentPaymentDay: '15',
        rentService: '',
        startDate,
        stayNote: '',
        unitId: initialUnitId,
      }),
      OPEN_RENT: ({ terms }) => ({ ...state, ...rentInputs(terms), rentEditorOpen: true }),
      RESTORE_DRAFT: ({ draft }) => ({ ...state, ...draft }),
      SET_CUSTOMER_OPEN: ({ open }) => ({ ...state, customerOpen: open }),
      SET_EDITOR: ({ mode }) => ({ ...state, editor: mode }),
      // Choosing a guest keeps who it is, so a later search that omits the guest does not lose the choice.
      SET_INPUT: ({ field, value }) =>
        field === 'guestId'
          ? {
              ...state,
              guest: Option.fromUndefinedOr(guestChoicesOf(state).find((item) => item.partyRef.resourceId === value)),
              guestId: value,
            }
          : { ...state, [field]: value },
      SET_RENT_EDITOR_OPEN: ({ open }) => ({ ...state, rentEditorOpen: open }),
    }),
  );
