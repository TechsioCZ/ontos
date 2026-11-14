// The fields of the lease and stay form. They change the draft only; the form's Save button sends it.
import { comboboxTranslations } from '@app/admin-ui';
import { withNativeLabels } from '@app/admin-ui/select-template';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { Combobox, FormInput } from '@app/admin-ui/form-controls';
import { Select } from '@techsio/ui-kit/molecules/select';
import type { OccupancyDraft } from './editor-state.ts';

export interface Choice {
  readonly label: string;
  readonly value: string;
}

type Change = (field: keyof OccupancyDraft, value: string) => void;

const LABEL_CHOOSE = 'property-leasing.demo.choose';

/** One single-choice select; an empty `value` means nothing chosen. */
export const ChoiceSelect = ({
  items,
  label,
  onChange,
  value,
}: {
  readonly items: readonly Choice[];
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly value: string;
}) => {
  const { t } = useModernI18n();
  return (
    <Select
      items={withNativeLabels(items.map((item) => ({ label: item.label, value: item.value })))}
      onValueChange={({ value: chosen }) => onChange(chosen[0] ?? '')}
      value={value.length > 0 ? [value] : []}
    >
      <Select.Label>{label}</Select.Label>
      <Select.Control>
        <Select.Trigger>
          <Select.ValueText placeholder={t(LABEL_CHOOSE)} />
        </Select.Trigger>
      </Select.Control>
      <Select.Positioner>
        <Select.Content>
          {items.map((item) => (
            <Select.Item item={{ label: item.label, value: item.value }} key={item.value}>
              <Select.ItemText>{item.label}</Select.ItemText>
              <Select.ItemIndicator />
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Positioner>
    </Select>
  );
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

export const CustomerField = ({
  customers,
  draft,
  onChange,
}: {
  readonly customers: CustomerPicker;
  readonly draft: OccupancyDraft;
  readonly onChange: Change;
}) => {
  const { language, t } = useModernI18n();
  const handleOpenChange = customers.onOpenChange;
  return (
    <div className="propertyleasing:space-y-2" onFocus={() => handleOpenChange(true)}>
      <Combobox
        clearable
        footer={customers.empty ? t('property-leasing.demo.customersEmpty') : undefined}
        items={[...customers.items]}
        label={t('property-leasing.demo.customer')}
        loading={customers.loading}
        loadingMessage={t('property-leasing.demo.customersLoading')}
        name="customer"
        noResultsMessage={t('property-leasing.demo.customersEmpty')}
        onChange={(value) => onChange('customerId', (Array.isArray(value) ? value[0] : value) ?? '')}
        onOpenChange={handleOpenChange}
        open={customers.open}
        placeholder={t('property-leasing.demo.customerPlaceholder')}
        translations={comboboxTranslations}
        value={draft.customerId.length > 0 ? [draft.customerId] : []}
      />
      <LinkButton href={`/${language}/prodej/zakaznici`} size="sm" theme="borderless" variant="secondary">
        {t('property-leasing.demo.newCustomerInRegistry')}
      </LinkButton>
    </div>
  );
};

export const PeriodFields = ({ draft, onChange }: { readonly draft: OccupancyDraft; readonly onChange: Change }) => {
  const { t } = useModernI18n();
  return (
    <div className="propertyleasing:grid propertyleasing:gap-4 propertyleasing:md:grid-cols-2">
      <FormInput
        id="occupancy-start-date"
        label={t('property-leasing.demo.startDate')}
        onChange={(event) => onChange('startDate', event.target.value)}
        type="date"
        value={draft.startDate}
      />
      <FormInput
        id="occupancy-end-date"
        label={t('property-leasing.demo.endDate')}
        onChange={(event) => onChange('endDate', event.target.value)}
        type="date"
        value={draft.endDate}
      />
    </div>
  );
};

export const RentFields = ({ draft, onChange }: { readonly draft: OccupancyDraft; readonly onChange: Change }) => {
  const { t } = useModernI18n();
  return (
    <section className="propertyleasing:space-y-3">
      <h3 className="propertyleasing:text-sm propertyleasing:font-semibold">{t('property-leasing.rent.title')}</h3>
      <div className="propertyleasing:grid propertyleasing:gap-4 propertyleasing:md:grid-cols-3">
        <FormInput
          id="occupancy-rent-monthly"
          inputMode="decimal"
          label={t('property-leasing.rent.monthlyRentInput')}
          onChange={(event) => onChange('rentMonthly', event.target.value)}
          value={draft.rentMonthly}
        />
        <FormInput
          id="occupancy-rent-service"
          inputMode="decimal"
          label={t('property-leasing.rent.serviceChargesInput')}
          onChange={(event) => onChange('rentService', event.target.value)}
          value={draft.rentService}
        />
        <FormInput
          id="occupancy-rent-payment-day"
          label={t('property-leasing.rent.paymentDayInput')}
          max={31}
          min={1}
          onChange={(event) => onChange('rentPaymentDay', event.target.value)}
          type="number"
          value={draft.rentPaymentDay}
        />
      </div>
    </section>
  );
};

/** The guest search of a new stay: looking parties up is a read, not part of the draft. */
export interface GuestSearch {
  readonly busy: boolean;
  readonly items: readonly Choice[];
  readonly onQueryChange: (query: string) => void;
  readonly onSearch: () => void;
  readonly query: string;
}

export const StayFields = ({
  draft,
  guests,
  onChange,
}: {
  readonly draft: OccupancyDraft;
  readonly guests: GuestSearch;
  readonly onChange: Change;
}) => {
  const { t } = useModernI18n();
  const handleSearch = guests.onSearch;
  return (
    <section className="propertyleasing:space-y-4">
      <p className="propertyleasing:text-sm propertyleasing:text-(--color-fg-secondary)">
        {t('property-leasing.booking.manualHint')}
      </p>
      <div className="propertyleasing:flex propertyleasing:items-end propertyleasing:gap-2">
        <div className="propertyleasing:min-w-0 propertyleasing:flex-1">
          <FormInput
            id="booking-guest-query"
            label={t('property-leasing.demo.guestSearch')}
            onChange={(event) => guests.onQueryChange(event.target.value)}
            value={guests.query}
          />
        </div>
        <Button disabled={guests.busy} onClick={handleSearch} size="sm" theme="outlined" variant="secondary">
          {t('property-leasing.demo.search')}
        </Button>
      </div>
      <ChoiceSelect
        items={guests.items}
        label={t('property-leasing.demo.guest')}
        onChange={(value) => onChange('guestId', value)}
        value={draft.guestId}
      />
      <FormInput
        id="stay-people-count"
        label={t('property-leasing.booking.peopleCount')}
        min={1}
        onChange={(event) => onChange('peopleCount', event.target.value)}
        required
        type="number"
        value={draft.peopleCount}
      />
      <FormInput
        id="stay-note"
        label={t('property-leasing.booking.note')}
        maxLength={500}
        onChange={(event) => onChange('stayNote', event.target.value)}
        value={draft.stayNote}
      />
    </section>
  );
};
