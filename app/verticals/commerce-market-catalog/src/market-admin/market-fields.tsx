// The market definition and price-list fields, shared by "Nový trh", "Upravit" and the price-list editor.
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import type { MarketChannel } from './eshops-model.ts';
import type {
  DefinitionField,
  JurisdictionKind,
  MarketDefinitionForm,
  MarketPricingForm,
  PricingField,
} from './market-form.ts';
import { jurisdictionKinds, marketChannels, marketCurrencies, offerModes, reasonValid } from './market-form.ts';
import { useMarketText } from './market-ui.tsx';

const item = (value: string, label: string) => ({ displayValue: label, label, value });

const errorProps = (shown: boolean, message: string) =>
  shown ? { helpText: message, validateStatus: 'error' as const } : {};

interface DefinitionFieldsProps {
  /** The market code is fixed once the market exists. */
  readonly codeEditable: boolean;
  readonly form: MarketDefinitionForm;
  readonly issues: readonly DefinitionField[];
  readonly onChange: (form: MarketDefinitionForm) => void;
  readonly prefix: string;
  /** Validation messages appear after the first submit attempt. */
  readonly showIssues: boolean;
}

export const DefinitionFields = ({
  codeEditable,
  form,
  issues,
  onChange,
  prefix,
  showIssues,
}: DefinitionFieldsProps) => {
  const { text } = useMarketText();
  const shown = (field: DefinitionField) => showIssues && issues.includes(field);
  const toggleChannel = (channel: MarketChannel, checked: boolean) =>
    onChange({
      ...form,
      channels: checked ? [...form.channels, channel] : form.channels.filter((candidate) => candidate !== channel),
    });
  return (
    <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
      <FormInput
        disabled={!codeEditable}
        id={`${prefix}-code`}
        label={text('form.code')}
        maxLength={64}
        name="marketCode"
        onChange={(event) => onChange({ ...form, code: event.target.value.toUpperCase() })}
        value={form.code}
        {...(shown('code') ? errorProps(true, text('form.codeError')) : { helpText: text('form.codeHelp') })}
      />
      <FormInput
        id={`${prefix}-purpose`}
        label={text('form.purpose')}
        maxLength={500}
        name="purpose"
        onChange={(event) => onChange({ ...form, purpose: event.target.value })}
        value={form.purpose}
        {...errorProps(shown('purpose'), text('form.purposeError'))}
      />
      <fieldset className="flex flex-col gap-100 sm:col-span-2">
        <legend className="font-medium text-sm">{text('form.channels')}</legend>
        <div className="flex flex-wrap gap-200">
          {marketChannels.map((channel) => (
            <FormCheckbox
              checked={form.channels.includes(channel)}
              id={`${prefix}-channel-${channel}`}
              key={channel}
              label={text(`form.channel${channel}`)}
              onCheckedChange={(checked: boolean) => toggleChannel(channel, checked)}
            />
          ))}
        </div>
        {shown('channels') && <p className="text-danger text-sm">{text('form.channelsError')}</p>}
      </fieldset>
      <SelectTemplate
        items={jurisdictionKinds.map((kind) => item(kind, text(`form.jurisdictionKind${kind}`)))}
        label={text('form.jurisdictionKind')}
        name="jurisdictionKind"
        onValueChange={(details: { readonly value: readonly string[] }) => {
          const kind = jurisdictionKinds.find((candidate: JurisdictionKind) => candidate === details.value[0]);
          if (kind !== undefined) {
            onChange({ ...form, jurisdictionKind: kind });
          }
        }}
        value={[form.jurisdictionKind]}
      />
      <FormInput
        id={`${prefix}-jurisdictions`}
        label={text('form.jurisdictions')}
        name="jurisdictions"
        onChange={(event) => onChange({ ...form, jurisdictionCodes: event.target.value })}
        value={form.jurisdictionCodes}
        {...(shown('jurisdictions')
          ? errorProps(true, text('form.jurisdictionsError'))
          : { helpText: text('form.jurisdictionsHelp') })}
      />
      <FormInput
        id={`${prefix}-locales`}
        label={text('form.locales')}
        name="locales"
        onChange={(event) => onChange({ ...form, locales: event.target.value })}
        value={form.locales}
        {...(shown('locales') ? errorProps(true, text('form.localesError')) : { helpText: text('form.localesHelp') })}
      />
      <div className="grid grid-cols-2 gap-200">
        <FormInput
          id={`${prefix}-valid-from`}
          label={text('form.validFrom')}
          name="validFrom"
          onChange={(event) => onChange({ ...form, validFrom: event.target.value })}
          type="date"
          value={form.validFrom}
          {...(shown('validFrom')
            ? errorProps(true, text('form.validFromError'))
            : { helpText: text('form.validFromHelp') })}
        />
        <FormInput
          id={`${prefix}-valid-to`}
          label={text('form.validTo')}
          name="validTo"
          onChange={(event) => onChange({ ...form, validTo: event.target.value })}
          type="date"
          value={form.validTo}
          {...(shown('validTo') ? errorProps(true, text('form.validToError')) : { helpText: text('form.validToHelp') })}
        />
      </div>
    </div>
  );
};

interface PricingFieldsProps {
  readonly form: MarketPricingForm;
  readonly issues: readonly PricingField[];
  readonly onChange: (form: MarketPricingForm) => void;
  readonly prefix: string;
  readonly showIssues: boolean;
}

export const PricingFields = ({ form, issues, onChange, prefix, showIssues }: PricingFieldsProps) => {
  const { text } = useMarketText();
  const shown = (field: PricingField) => showIssues && issues.includes(field);
  return (
    <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
      <SelectTemplate
        items={marketCurrencies.map((currency) => item(currency, currency))}
        label={text('form.currency')}
        name="currency"
        onValueChange={(details: { readonly value: readonly string[] }) => {
          const currency = marketCurrencies.find((candidate) => candidate === details.value[0]);
          if (currency !== undefined) {
            onChange({ ...form, currency });
          }
        }}
        value={[form.currency]}
      />
      <SelectTemplate
        items={offerModes.map((mode) => item(mode, text(`form.offerMode${mode}`)))}
        label={text('form.offerMode')}
        name="offerMode"
        onValueChange={(details: { readonly value: readonly string[] }) => {
          const mode = offerModes.find((candidate) => candidate === details.value[0]);
          if (mode !== undefined) {
            onChange({ ...form, offerMode: mode });
          }
        }}
        value={[form.offerMode]}
      />
      <FormInput
        id={`${prefix}-rate`}
        inputMode="decimal"
        label={text('form.exchangeRate')}
        name="exchangeRate"
        onChange={(event) => onChange({ ...form, exchangeRate: event.target.value })}
        value={form.exchangeRate}
        {...(shown('exchangeRate')
          ? errorProps(true, text('form.exchangeRateError'))
          : { helpText: text('form.exchangeRateHelp') })}
      />
      <FormInput
        id={`${prefix}-rounding`}
        inputMode="numeric"
        label={text('form.rounding')}
        name="roundingMinor"
        onChange={(event) => onChange({ ...form, roundingMinor: event.target.value })}
        value={form.roundingMinor}
        {...(shown('roundingMinor')
          ? errorProps(true, text('form.roundingError'))
          : { helpText: text('form.roundingHelp') })}
      />
    </div>
  );
};

interface ReasonFieldProps {
  readonly id: string;
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly showIssue: boolean;
  readonly value: string;
}

/** The mandatory reason of a recorded change. */
export const ReasonField = ({ id, label, onChange, showIssue, value }: ReasonFieldProps) => {
  const { text } = useMarketText();
  return (
    <FormInput
      id={id}
      label={label}
      maxLength={500}
      name="reason"
      onChange={(event) => onChange(event.target.value)}
      value={value}
      {...errorProps(showIssue && !reasonValid(value), text('form.reasonError'))}
    />
  );
};
