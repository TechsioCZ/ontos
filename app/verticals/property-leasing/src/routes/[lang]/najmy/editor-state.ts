import { Data, Match, Option } from 'effect';
import type { Effect, Schema } from 'effect';
import type { listCustomers, loadPartiesClient } from '@app/party-registry/api/client';
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
export interface OccupancyEditorState extends EditorInputs {
  readonly customerOpen: boolean;
  readonly customers: Effect.Success<ReturnType<typeof listCustomers>>;
  readonly customersLoading: boolean;
  readonly editor: Option.Option<'lease' | 'stay'>;
  readonly guests: Effect.Success<ReturnType<typeof loadPartiesClient>>;
  readonly rentEditorOpen: boolean;
}
export type OccupancyEditorMode = Option.Option.Value<OccupancyEditorState['editor']>;
export type OccupancyEditorAction = Data.TaggedEnum<{
  CLEAR: { readonly startDate: EditorInputs['startDate'] };
  CUSTOMERS_LOADED: { readonly customers: OccupancyEditorState['customers'] };
  CUSTOMERS_LOADING: { readonly loading: boolean };
  EDIT_DRAFT: { readonly record: Occupancy };
  GUESTS_LOADED: { readonly guests: OccupancyEditorState['guests'] };
  OPEN_DRAFT: {
    readonly initialUnitId: string;
    readonly mode: OccupancyEditorMode;
    readonly startDate: EditorInputs['startDate'];
  };
  OPEN_RENT: { readonly terms: Option.Option<RentTerms> };
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
  guestId: '',
  guestQuery: '',
  guests: [],
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
        guestId: '',
        guestQuery: '',
        guests: [],
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
      GUESTS_LOADED: ({ guests }) => ({ ...state, guestId: '', guests }),
      OPEN_DRAFT: ({ initialUnitId, mode, startDate }) => ({
        ...state,
        customerId: '',
        customers: [],
        customersLoading: mode === 'lease' || state.customersLoading,
        editingId: '',
        editor: Option.some(mode),
        endDate: '',
        guestId: '',
        guestQuery: '',
        guests: [],
        peopleCount: '2',
        rentMonthly: '',
        rentPaymentDay: '15',
        rentService: '',
        startDate,
        stayNote: '',
        unitId: initialUnitId,
      }),
      OPEN_RENT: ({ terms }) => ({ ...state, ...rentInputs(terms), rentEditorOpen: true }),
      SET_CUSTOMER_OPEN: ({ open }) => ({ ...state, customerOpen: open }),
      SET_EDITOR: ({ mode }) => ({ ...state, editor: mode }),
      SET_INPUT: ({ field, value }) => ({ ...state, [field]: value }),
      SET_RENT_EDITOR_OPEN: ({ open }) => ({ ...state, rentEditorOpen: open }),
    }),
  );
