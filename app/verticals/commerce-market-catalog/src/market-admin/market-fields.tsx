// The market definition and price-list fields, shared by "Nový trh", "Upravit" and the price-list editor. Each form
// that shows them builds its effect-form state from the field groups below and renders its own controls here.
import {
  ChoiceField,
  FormRootError,
  MemberCheckboxField,
  TextField,
  UpperCaseTextField,
  fromPayload,
  useAtomSet,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import type { FormBuilder, FormReact, PayloadFormFields } from '@app/core-runtime/ui/form';
import { Option } from 'effect';
import type { Atom } from 'effect/reactivity';
import { useEffect, useState } from 'react';
import type { ComponentProps, FC } from 'react';
import {
  jurisdictionKinds,
  MarketDefinitionInputSchema,
  MarketPricingInputSchema,
  marketChannels,
  marketCurrencies,
  offerModes,
} from './market-form.ts';
import { useMarketText } from './market-ui.tsx';

/** The definition fields of a market form, each checked by the definition rules. */
export const definitionFields: FormBuilder.FormBuilder<
  PayloadFormFields<typeof MarketDefinitionInputSchema.fields>,
  never
> = fromPayload(MarketDefinitionInputSchema);
/** The binding of each definition field. */
export interface DefinitionBindings {
  readonly channels: typeof MemberCheckboxField;
  readonly code: typeof UpperCaseTextField;
  readonly jurisdictionCodes: typeof TextField;
  readonly jurisdictionKind: typeof ChoiceField;
  readonly locales: typeof TextField;
  readonly purpose: typeof TextField;
  readonly validFrom: typeof TextField;
  readonly validTo: typeof TextField;
}
export const definitionControls: DefinitionBindings = {
  channels: MemberCheckboxField,
  code: UpperCaseTextField,
  jurisdictionCodes: TextField,
  jurisdictionKind: ChoiceField,
  locales: TextField,
  purpose: TextField,
  validFrom: TextField,
  validTo: TextField,
};

/** The price-list fields of a market form, each checked by the price-list rules. */
export const pricingFields: FormBuilder.FormBuilder<
  PayloadFormFields<typeof MarketPricingInputSchema.fields>,
  never
> = fromPayload(MarketPricingInputSchema);
/** The binding of each price-list field. */
export interface PricingBindings {
  readonly currency: typeof ChoiceField;
  readonly exchangeRate: typeof TextField;
  readonly offerMode: typeof ChoiceField;
  readonly roundingMinor: typeof TextField;
}
export const pricingControls: PricingBindings = {
  currency: ChoiceField,
  exchangeRate: TextField,
  offerMode: ChoiceField,
  roundingMinor: TextField,
};

/** The rendered controls of a built form for the given bindings. */
type Controls<Bindings> = { readonly [Key in keyof Bindings]: FC<FormReact.ExtractExtraProps<Bindings[Key]>> };

/** The parts of a built form whose checks the fields follow. */
interface CheckedForm<Values> {
  readonly validate: Atom.AtomResultFn<void, void>;
  readonly validationCount: Atom.Atom<number>;
  readonly values: Atom.Atom<Option.Option<Values>>;
}

/**
 * Field messages follow the values: once `checking` turns true (the draft is invalid), the form is checked on every
 * change, so each field names its own issue and drops it as soon as it is fixed. Render it inside the form's
 * `FormRoot`.
 */
export const LiveChecks = <Values,>({
  checking,
  form,
}: {
  readonly checking: boolean;
  readonly form: CheckedForm<Values>;
}) => {
  const validate = useAtomSet(form.validate);
  const checked = useAtomValue(form.validationCount) > 0;
  const values = Option.getOrNull(useAtomValue(form.values));
  useEffect(() => {
    if (values !== null && (checking || checked)) {
      validate();
    }
  }, [checked, checking, validate, values]);
  return null;
};

/** Rendered inside `FormRoot`, which renders its children only once this mount initialized the form. */
const FormReady = ({ onReady }: { readonly onReady: (ready: boolean) => void }) => {
  useEffect(() => onReady(true), [onReady]);
  return null;
};

/**
 * The form's values once this mount initialized them, `opened` until then: the atoms of a module-level form can still
 * hold what an earlier mount left. Render `ready` inside the form's `FormRoot`.
 */
export const useOpenedValues = <Values,>(values: Atom.Atom<Option.Option<Values>>, opened: Values) => {
  const [ready, setReady] = useState(false);
  const shown = Option.getOrElse(
    Option.filter(useAtomValue(values), () => ready),
    () => opened,
  );
  return { ready: <FormReady onReady={setReady} />, values: shown };
};

const choice = (value: string, label: string) => ({ label, value });

interface DefinitionFieldsProps {
  /** The market code is fixed once the market exists. */
  readonly codeEditable: boolean;
  readonly form: Controls<typeof definitionControls> & ComponentProps<typeof FormRootError>['form'];
  readonly prefix: string;
}

export const DefinitionFields = ({ codeEditable, form, prefix }: DefinitionFieldsProps) => {
  const { text } = useMarketText();
  return (
    <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
      <form.code
        disabled={!codeEditable}
        helpText={text('form.codeHelp')}
        id={`${prefix}-code`}
        label={text('form.code')}
        maxLength={64}
        name="marketCode"
      />
      <form.purpose id={`${prefix}-purpose`} label={text('form.purpose')} maxLength={500} name="purpose" />
      <fieldset className="flex flex-col gap-100 sm:col-span-2">
        <legend className="font-medium text-sm">{text('form.channels')}</legend>
        <div className="flex flex-wrap gap-200">
          {marketChannels.map((channel) => (
            <form.channels
              id={`${prefix}-channel-${channel}`}
              key={channel}
              label={text(`form.channel${channel}`)}
              member={channel}
            />
          ))}
        </div>
        {/* The definition's one form-level issue is a missing channel. */}
        <FormRootError form={form} />
      </fieldset>
      <form.jurisdictionKind
        items={jurisdictionKinds.map((kind) => choice(kind, text(`form.jurisdictionKind${kind}`)))}
        label={text('form.jurisdictionKind')}
      />
      <form.jurisdictionCodes
        helpText={text('form.jurisdictionsHelp')}
        id={`${prefix}-jurisdictions`}
        label={text('form.jurisdictions')}
        name="jurisdictions"
      />
      <form.locales
        helpText={text('form.localesHelp')}
        id={`${prefix}-locales`}
        label={text('form.locales')}
        name="locales"
      />
      <div className="grid grid-cols-2 gap-200">
        <form.validFrom
          helpText={text('form.validFromHelp')}
          id={`${prefix}-valid-from`}
          label={text('form.validFrom')}
          name="validFrom"
          type="date"
        />
        <form.validTo
          helpText={text('form.validToHelp')}
          id={`${prefix}-valid-to`}
          label={text('form.validTo')}
          name="validTo"
          type="date"
        />
      </div>
    </div>
  );
};

interface PricingFieldsProps {
  readonly form: Controls<typeof pricingControls>;
  readonly prefix: string;
  /** The new-market dialog keeps md; the market detail section uses sm. */
  readonly size?: 'sm' | 'md';
}

export const PricingFields = ({ form, prefix, size = 'md' }: PricingFieldsProps) => {
  const { text } = useMarketText();
  return (
    <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
      <form.currency
        items={marketCurrencies.map((currency) => choice(currency, currency))}
        label={text('form.currency')}
      />
      <form.offerMode
        items={offerModes.map((mode) => choice(mode, text(`form.offerMode${mode}`)))}
        label={text('form.offerMode')}
      />
      <form.exchangeRate
        helpText={text('form.exchangeRateHelp')}
        id={`${prefix}-rate`}
        inputMode="decimal"
        label={text('form.exchangeRate')}
        name="exchangeRate"
        size={size}
      />
      <form.roundingMinor
        helpText={text('form.roundingHelp')}
        id={`${prefix}-rounding`}
        inputMode="numeric"
        label={text('form.rounding')}
        name="roundingMinor"
        size={size}
      />
    </div>
  );
};
