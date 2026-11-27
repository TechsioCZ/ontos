// The fields of the lease and stay form. They change the form only; the form's Save button sends its draft.
import { comboboxTranslations, requiredLabelFor } from '@app/admin-ui';
import {
  ChoiceField,
  ClearableChoiceField,
  ComboboxField,
  FormBuilder,
  FormReact,
  FormRoot,
  TextField,
  useAtomSet,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import type { FieldChoice } from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { Effect, Option, Schema } from 'effect';
import type { ReactNode } from 'react';
import { browserAtomRuntime } from '../../../runtime/browser-effect-runtime.ts';
import type { OccupancyDraft } from './editor-state.ts';

export type Choice = FieldChoice;

const LABEL_CHOOSE = 'property-leasing.demo.choose';

/**
 * The lease and stay form: the draft its Save button sends, and the guest search box, which only looks parties up.
 * Enter submits nothing: only Uložit sends the draft.
 */
const occupancyForm = FormReact.make(
  FormBuilder.empty
    .addField('customerId', Schema.String)
    .addField('endDate', Schema.String)
    .addField('guestId', Schema.String)
    .addField('guestQuery', Schema.String)
    .addField('peopleCount', Schema.String)
    .addField('rentMonthly', Schema.String)
    .addField('rentPaymentDay', Schema.String)
    .addField('rentService', Schema.String)
    .addField('startDate', Schema.String)
    .addField('stayNote', Schema.String)
    .addField('unitId', Schema.String),
  {
    fields: {
      customerId: ComboboxField,
      endDate: TextField,
      guestId: ClearableChoiceField,
      guestQuery: TextField,
      peopleCount: TextField,
      rentMonthly: TextField,
      rentPaymentDay: TextField,
      rentService: TextField,
      startDate: TextField,
      stayNote: TextField,
      unitId: ChoiceField,
    },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);

/** What the form holds: the draft and the guest search box. */
export interface OccupancyValues extends OccupancyDraft {
  readonly guestQuery: string;
}

/** The form's values for `draft`, with the guest search box as typed. */
export const occupancyValuesOf = (draft: OccupancyDraft, guestQuery: string): OccupancyValues => ({
  ...draft,
  guestQuery,
});

/** The draft the form's values stand for: everything but the guest search box. */
export const occupancyDraftOf = (values: OccupancyValues): OccupancyDraft => ({
  customerId: values.customerId,
  endDate: values.endDate,
  guestId: values.guestId,
  peopleCount: values.peopleCount,
  rentMonthly: values.rentMonthly,
  rentPaymentDay: values.rentPaymentDay,
  rentService: values.rentService,
  startDate: values.startDate,
  stayNote: values.stayNote,
  unitId: values.unitId,
});

/**
 * The lease and stay form around its fields: it opens with `opened` and an empty guest search box. Its children render
 * once this mount initialized the form.
 */
export const OccupancyFormRoot = ({
  children,
  className,
  opened,
}: {
  readonly children: ReactNode;
  readonly className: string;
  readonly opened: OccupancyDraft;
}) => {
  const { t } = useModernI18n();
  return (
    <FormRoot
      className={className}
      defaultValues={occupancyValuesOf(opened, '')}
      form={occupancyForm}
      translateMessage={(message) => t(message)}
    >
      {children}
    </FormRoot>
  );
};

/** The form's values; None until a form initialized them. */
export const useOccupancyValues = (): Option.Option<OccupancyValues> => useAtomValue(occupancyForm.values);

/** Puts values into the form. */
export const useSetOccupancyValues = (): ((values: OccupancyValues) => void) => useAtomSet(occupancyForm.setValues);

export const UnitField = ({ items }: { readonly items: readonly Choice[] }) => {
  const { t } = useModernI18n();
  return <occupancyForm.unitId items={items} label={t('property-leasing.demo.unit')} placeholder={t(LABEL_CHOOSE)} />;
};

/**
 * The tenant picker of a new lease; the customers load after the form opens. A missing tenant is created in Party
 * Registry's own customer register, and the list shows it the next time the form opens.
 */
export interface CustomerPicker {
  readonly empty: boolean;
  readonly items: readonly Choice[];
  readonly loading: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
}

export const CustomerField = ({ customers }: { readonly customers: CustomerPicker }) => {
  const { language, t } = useModernI18n();
  const handleOpenChange = customers.onOpenChange;
  return (
    <div className="propertyleasing:space-y-2" onFocus={() => handleOpenChange(true)}>
      <occupancyForm.customerId
        clearable
        footer={customers.empty ? t('property-leasing.demo.customersEmpty') : undefined}
        items={[...customers.items]}
        label={t('property-leasing.demo.customer')}
        loading={customers.loading}
        loadingMessage={t('property-leasing.demo.customersLoading')}
        name="customer"
        noResultsMessage={t('property-leasing.demo.customersEmpty')}
        onOpenChange={handleOpenChange}
        open={customers.open}
        placeholder={t('property-leasing.demo.customerPlaceholder')}
        translations={comboboxTranslations}
      />
      <LinkButton appearance="ghost" href={`/${language}/prodej/zakaznici`} severity="secondary" size="sm">
        {t('property-leasing.demo.newCustomerInRegistry')}
      </LinkButton>
    </div>
  );
};

export const PeriodFields = () => {
  const { t } = useModernI18n();
  return (
    <div className="propertyleasing:grid propertyleasing:gap-4 propertyleasing:md:grid-cols-2">
      <occupancyForm.startDate id="occupancy-start-date" label={t('property-leasing.demo.startDate')} type="date" />
      <occupancyForm.endDate id="occupancy-end-date" label={t('property-leasing.demo.endDate')} type="date" />
    </div>
  );
};

export const RentFields = () => {
  const { t } = useModernI18n();
  return (
    <section className="propertyleasing:space-y-3">
      <h3 className="propertyleasing:text-sm propertyleasing:font-semibold">{t('property-leasing.rent.title')}</h3>
      <div className="propertyleasing:grid propertyleasing:gap-4 propertyleasing:md:grid-cols-3">
        <occupancyForm.rentMonthly
          id="occupancy-rent-monthly"
          inputMode="decimal"
          label={t('property-leasing.rent.monthlyRentInput')}
        />
        <occupancyForm.rentService
          id="occupancy-rent-service"
          inputMode="decimal"
          label={t('property-leasing.rent.serviceChargesInput')}
        />
        <occupancyForm.rentPaymentDay
          id="occupancy-rent-payment-day"
          label={t('property-leasing.rent.paymentDayInput')}
          max={31}
          min={1}
          type="number"
        />
      </div>
    </section>
  );
};

/** The guest search of a new stay: looking parties up is a read, not part of the draft. */
export interface GuestSearch {
  readonly busy: boolean;
  /** Why the latest search found nothing to offer, when it failed. */
  readonly failure?: string | undefined;
  /** What the latest search found. */
  readonly items: readonly Choice[];
  /** The guest the person chose that the latest search omits. */
  readonly kept: Option.Option<Choice>;
  /** The person chose a guest, or cleared the choice (`""`). */
  readonly onChoose: (guestId: string) => void;
  /** Looks up the parties matching the typed query. */
  readonly onSearch: (query: string) => void;
}

/**
 * The guests the stay form offers: the latest search's hits, and the chosen guest they omit while it is still the one
 * chosen. The picker treats them as its complete collection.
 */
const guestItemsOf = (guests: GuestSearch, guestId: string): readonly Choice[] =>
  Option.match(guests.kept.pipe(Option.filter((kept) => kept.value === guestId)), {
    onNone: () => guests.items,
    onSome: (kept) => [kept, ...guests.items],
  });

export const StayFields = ({
  guestId,
  guests,
  query,
}: {
  readonly guestId: string;
  readonly guests: GuestSearch;
  readonly query: string;
}) => {
  const { language, t } = useModernI18n();
  const handleChoose = guests.onChoose;
  return (
    <section className="propertyleasing:space-y-4">
      <p className="propertyleasing:text-sm propertyleasing:text-(--color-fg-secondary)">
        {t('property-leasing.booking.manualHint')}
      </p>
      <div className="propertyleasing:flex propertyleasing:items-end propertyleasing:gap-2">
        <div className="propertyleasing:min-w-0 propertyleasing:flex-1">
          <occupancyForm.guestQuery id="booking-guest-query" label={t('property-leasing.demo.guestSearch')} />
        </div>
        <Button
          appearance="outline"
          disabled={guests.busy}
          onClick={() => guests.onSearch(query)}
          severity="secondary"
          size="sm"
          type="button"
        >
          {t('property-leasing.demo.search')}
        </Button>
      </div>
      <occupancyForm.guestId
        clearLabel={(name) => t('property-leasing.demo.clearGuest', { name })}
        items={guestItemsOf(guests, guestId)}
        label={t('property-leasing.demo.guest')}
        onChoose={handleChoose}
        placeholder={t(LABEL_CHOOSE)}
        warning={guests.failure}
      />
      <occupancyForm.peopleCount
        id="stay-people-count"
        label={t('property-leasing.booking.peopleCount')}
        min={1}
        required
        requiredLabel={requiredLabelFor(language)}
        type="number"
      />
      <occupancyForm.stayNote id="stay-note" label={t('property-leasing.booking.note')} maxLength={500} />
    </section>
  );
};
