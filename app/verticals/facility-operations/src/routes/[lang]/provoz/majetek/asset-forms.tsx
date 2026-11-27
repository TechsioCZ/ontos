// Forms of the assets page. Each holds its values in its effect-form form and renders the shared Uložit last in the
// SidePanel footer, which builds a typed command from them and runs it through the panel's `onSubmit` (the governed
// apply-command Action); Enter sends nothing. The edit card mirrors the page's draft, so an edit of a stored asset is
// sent by the panel's Uložit. Owned by ops-assets.
import {
  CheckboxField,
  ChoiceField,
  FormBuilder,
  FormReact,
  FormRoot,
  RuledTextField,
  TextAreaField,
  TextField,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Effect, Option as EffectOption, Schema } from 'effect';
import { Atom } from 'effect/reactivity';
import type { TOptions } from 'i18next';
import { useEffect, useRef, useState } from 'react';
import type { OpsCommand } from '../../../../../shared/agendas.ts';
import type {
  Asset,
  AssetsState,
  DepreciationInterval,
  DepreciationPlan,
  DepreciationType,
  DisposalKind,
  PermitState,
  ServiceKind,
  ServiceResult,
} from '../../../../../shared/domain/assets.ts';
import {
  acquisitionMethods,
  approvedTotal,
  assetKinds,
  disposalKinds,
  indicativeSchedule,
  isActiveAsset,
  manualEventKinds,
  PermitStateSchema,
  serviceKinds,
  ServiceResultSchema,
} from '../../../../../shared/domain/assets.ts';
import { optionalField } from '../../../../../shared/domain/common.ts';
import { assetCardCreateCommandOf, assetCardDraftOf, assetCardProblems } from './asset-card-draft.ts';
import type { AssetCardDraft } from './asset-card-draft.ts';
import { money, parseCzk, todayIsoDate } from './assets-model.ts';
import { ErrorLine, FormGrid, PanelForm, optional, textArea, textInput, useRequired } from './form-kit.tsx';
import type { AssetSubmit, Option } from './form-kit.tsx';
import { assetPlacementOf, locationItems, usePropertyTree } from './property-tree.ts';
import type { PropertyTree } from './property-tree.ts';
import { surfaceTileClassName } from '@app/admin-ui';
import { browserAtomRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { useFormValues } from '../../../../ui/form-values.tsx';

export interface FormProps {
  /** How the panel runs the command the form built; the form's Uložit sits last in the panel footer. */
  readonly onSubmit: AssetSubmit;
}

const useK = () => {
  const { t } = useModernI18n();
  return (key: string, options?: TOptions) => t(`facility-operations.assets.${key}`, options);
};

const NONE = 'none';
const formText = {
  amountHelp: 'form.amountHelp',
  date: 'fields.date',
  documentHelp: 'form.documentHelp',
  documentRef: 'fields.documentRef',
  invalidAmount: 'form.invalidAmount',
  note: 'fields.note',
  reasonRequired: 'form.reasonRequired',
  required: 'form.required',
} as const;

const locationOptions = (tree: PropertyTree, none: string): Option[] => [
  { label: none, value: NONE },
  ...locationItems(tree).map((item) => ({ label: item.label, value: item.value })),
];

/** The fields of an assets form: what Uložit sends is the form's values, so Enter sends nothing. */
const ledgerForm = { onSubmit: () => Effect.void, runtime: browserAtomRuntime } as const;

// ── Create / edit card ──────────────────────────────────────────────────────────────────────────────────

const makeCardForm = () =>
  FormReact.make(
    FormBuilder.empty
      .addField('accountingProduct', Schema.String)
      .addField('acquisitionDateInput', Schema.String)
      .addField('acquisitionMethod', Schema.String)
      .addField('acquisitionValue', Schema.String)
      .addField('category', Schema.String)
      .addField('inventoryNumber', Schema.String)
      .addField('kind', Schema.String)
      .addField('location', Schema.String)
      .addField('name', Schema.String)
      .addField('note', Schema.String)
      .addField('placedInServiceDateInput', Schema.String)
      .addField('responsible', Schema.String)
      .addField('serialNumber', Schema.String),
    {
      ...ledgerForm,
      fields: {
        accountingProduct: TextField,
        acquisitionDateInput: TextField,
        acquisitionMethod: ChoiceField,
        acquisitionValue: RuledTextField,
        category: RuledTextField,
        inventoryNumber: RuledTextField,
        kind: ChoiceField,
        location: ChoiceField,
        name: RuledTextField,
        note: TextAreaField,
        placedInServiceDateInput: TextField,
        responsible: TextField,
        serialNumber: TextField,
      },
    },
  );

/** A new card and the edit of a stored one are separate forms. */
const cardCreateForm = makeCardForm();
const cardEditForm = makeCardForm();
type CardForm = typeof cardCreateForm;
type CardValues = CardForm['schema']['Encoded'];

/** The values the card form shows for a draft: no location is the "none" choice. */
const cardValuesOf = (draft: AssetCardDraft): CardValues => ({
  ...draft,
  location: draft.location === '' ? NONE : draft.location,
});

/** The draft the card form shows; a kind or method that is not one of the choices is the default one. */
const cardDraftFrom = (values: CardValues): AssetCardDraft => ({
  ...values,
  acquisitionMethod: acquisitionMethods.find((entry) => entry === values.acquisitionMethod) ?? 'purchase',
  kind: assetKinds.find((entry) => entry === values.kind) ?? 'equipment',
  location: values.location === NONE ? '' : values.location,
});

const cardKeys = [
  'accountingProduct',
  'acquisitionDateInput',
  'acquisitionMethod',
  'acquisitionValue',
  'category',
  'inventoryNumber',
  'kind',
  'location',
  'name',
  'note',
  'placedInServiceDateInput',
  'responsible',
  'serialNumber',
] as const;

const sameCardValues = (left: CardValues, right: CardValues): boolean =>
  cardKeys.every((key) => left[key] === right[key]);

const AssetCardFields = ({
  asset,
  error,
  form,
  values,
}: {
  readonly asset?: Asset | undefined;
  readonly error: string | undefined;
  readonly form: CardForm;
  readonly values: CardValues;
}) => {
  const k = useK();
  const required = useRequired();
  const tree = usePropertyTree();
  const problems = assetCardProblems(cardDraftFrom(values));
  return (
    <>
      <ErrorLine message={error} />
      <FormGrid>
        <form.inventoryNumber
          {...textInput}
          {...required}
          id="asset-inventory-number"
          invalid={problems.inventoryNumber}
          label={k('fields.inventoryNumber')}
          maxLength={64}
          {...(asset === undefined ? {} : { helpText: k('form.numberFixed') })}
        />
        <form.kind
          items={assetKinds.map((entry) => ({ label: k(`kind.${entry}`), value: entry }))}
          label={k('fields.kind')}
        />
      </FormGrid>
      <form.name {...textInput} {...required} id="asset-name" invalid={problems.name} label={k('fields.name')} />
      <FormGrid>
        <form.category
          {...textInput}
          {...required}
          id="asset-category"
          invalid={problems.category}
          label={k('fields.category')}
          maxLength={120}
          placeholder={k('form.categoryPlaceholder')}
        />
        <form.serialNumber {...textInput} id="asset-serial" label={k('fields.serialNumber')} maxLength={120} />
      </FormGrid>
      <form.location items={locationOptions(tree, k('form.noLocation'))} label={k('fields.location')} />
      {tree.status === 'failed' && <ErrorLine message={k('form.propertiesFailed')} />}
      <form.responsible {...textInput} id="asset-responsible" label={k('fields.responsible')} />
      {asset === undefined && (
        <>
          <FormGrid>
            <form.acquisitionDateInput
              {...textInput}
              id="asset-acquisition-date"
              label={k('fields.acquisitionDate')}
              type="date"
            />
            <form.acquisitionMethod
              items={acquisitionMethods.map((entry) => ({ label: k(`method.${entry}`), value: entry }))}
              label={k('fields.acquisitionMethod')}
            />
          </FormGrid>
          <FormGrid>
            <form.acquisitionValue
              {...textInput}
              helpText={k(formText.amountHelp)}
              id="asset-acquisition-value"
              inputMode="decimal"
              invalid={problems.amount}
              label={k('fields.acquisitionValue')}
            />
            <form.placedInServiceDateInput
              {...textInput}
              id="asset-in-service"
              label={k('fields.placedInService')}
              type="date"
            />
          </FormGrid>
        </>
      )}
      <form.accountingProduct
        {...textInput}
        helpText={k('form.accountingProductHelp')}
        id="asset-accounting-product"
        label={k('fields.accountingProduct')}
      />
      <form.note {...textArea} id="asset-note" label={k(formText.note)} />
    </>
  );
};

export interface AssetCardFormProps {
  readonly asset: Asset;
  /** The page owns the draft, so an edit is saved from the panel footer. */
  readonly draft: AssetCardDraft;
  readonly onChange: (patch: Partial<AssetCardDraft>) => void;
  readonly state: AssetsState;
}

/**
 * The edit of a stored card. The page owns its draft and saves it from the panel's save bar; the form shows that draft,
 * hands every change to it and takes it back when the page replaces it (a newer read, Zahodit změny, the latest version).
 */
export const AssetCardForm = ({ asset, draft, onChange }: AssetCardFormProps) => {
  const { t } = useModernI18n();
  const shown = useFormValues(cardEditForm, cardValuesOf(draft));
  const setValues = useAtomSet(cardEditForm.setValues);
  useAtomSubscribe(cardEditForm.values, (next) => {
    if (shown.initialized && EffectOption.isSome(next) && !sameCardValues(next.value, cardValuesOf(draft))) {
      onChange(cardDraftFrom(next.value));
    }
  });
  const pageValues = cardValuesOf(draft);
  // The page replaced its draft (a newer read, Zahodit změny, the latest version): the form shows the new one. A
  // draft the form itself handed over is already on screen.
  const lastPage = useRef(pageValues);
  useEffect(() => {
    const changed = !sameCardValues(lastPage.current, pageValues);
    lastPage.current = pageValues;
    if (changed && shown.initialized && !sameCardValues(pageValues, shown.values)) {
      setValues(pageValues);
    }
  }, [pageValues, setValues, shown.initialized, shown.values]);
  return (
    <FormRoot
      className="flex flex-col gap-200 py-200"
      defaultValues={pageValues}
      form={cardEditForm}
      key={asset.id}
      translateMessage={(message) => t(message)}
    >
      {shown.ready}
      <AssetCardFields asset={asset} error={undefined} form={cardEditForm} values={shown.values} />
    </FormRoot>
  );
};

/** A new asset card: the footer's Uložit creates the asset once. */
export const AssetCardCreateForm = ({ onSubmit, state }: FormProps & { readonly state: AssetsState }) => {
  const k = useK();
  const tree = usePropertyTree();
  const [error, setError] = useState<string | undefined>();
  const command = (values: CardValues): OpsCommand | undefined => {
    const draft = cardDraftFrom(values);
    const problems = assetCardProblems(draft);
    if (problems.inventoryNumber || problems.name || problems.category) {
      setError(k(formText.required));
      return undefined;
    }
    if (
      state.assets.some((entry) => entry.inventoryNumber.toLowerCase() === draft.inventoryNumber.trim().toLowerCase())
    ) {
      setError(k('form.duplicateNumber'));
      return undefined;
    }
    if (problems.amount) {
      setError(k(formText.invalidAmount));
      return undefined;
    }
    setError(undefined);
    return EffectOption.getOrUndefined(assetCardCreateCommandOf(draft, assetPlacementOf(tree, draft)));
  };
  return (
    <PanelForm
      command={command}
      error={error}
      form={cardCreateForm}
      onSubmit={onSubmit}
      opened={cardValuesOf(assetCardDraftOf())}
    >
      {(values) => <AssetCardFields error={error} form={cardCreateForm} values={values} />}
    </PanelForm>
  );
};

// ── Value change (S02-02) ─────────────────────────────────────────────────────────────────────────────

const valueChangeForm = FormReact.make(
  FormBuilder.empty
    .addField('date', Schema.String)
    .addField('documentRef', Schema.String)
    .addField('reason', Schema.String)
    .addField('value', Schema.String),
  { ...ledgerForm, fields: { date: TextField, documentRef: TextField, reason: TextAreaField, value: TextField } },
);

export const ValueChangeForm = ({ asset, onSubmit }: FormProps & { readonly asset: Asset }) => {
  const k = useK();
  const required = useRequired();
  const [error, setError] = useState<string | undefined>();
  const command = ({
    date,
    documentRef,
    reason,
    value,
  }: typeof valueChangeForm.schema.Encoded): OpsCommand | undefined => {
    const parsed = parseCzk(value);
    if (parsed === undefined || parsed === null) {
      setError(k(formText.invalidAmount));
      return undefined;
    }
    if (reason.trim() === '' || date === '') {
      setError(k(formText.reasonRequired));
      return undefined;
    }
    setError(undefined);
    return {
      _tag: 'AssetValueChange',
      assetId: asset.id,
      date,
      newValueMinor: parsed,
      reason: reason.trim(),
      ...optional('documentRef', documentRef),
    };
  };
  return (
    <PanelForm
      command={command}
      error={error}
      form={valueChangeForm}
      onSubmit={onSubmit}
      opened={{ date: todayIsoDate(), documentRef: '', reason: '', value: '' }}
    >
      <p className="text-fg-secondary text-sm">
        {k('form.valueIntro', { value: money(asset.currentValueMinor, k('notProvided')) })}
      </p>
      <ErrorLine message={error} />
      <FormGrid>
        <valueChangeForm.value
          {...textInput}
          {...required}
          helpText={k(formText.amountHelp)}
          id="value-new"
          inputMode="decimal"
          label={k('fields.newValue')}
        />
        <valueChangeForm.date {...textInput} {...required} id="value-date" label={k('fields.valueDate')} type="date" />
      </FormGrid>
      <valueChangeForm.reason
        {...textArea}
        {...required}
        helpText={k('form.reasonHelp')}
        id="value-reason"
        label={k('fields.reason')}
      />
      <valueChangeForm.documentRef
        {...textInput}
        helpText={k(formText.documentHelp)}
        id="value-document"
        label={k(formText.documentRef)}
      />
    </PanelForm>
  );
};

// ── Timeline event ────────────────────────────────────────────────────────────────────────────────────

const eventForm = FormReact.make(
  FormBuilder.empty
    .addField('date', Schema.String)
    .addField('documentRef', Schema.String)
    .addField('kind', Schema.String)
    .addField('note', Schema.String),
  { ...ledgerForm, fields: { date: TextField, documentRef: TextField, kind: ChoiceField, note: TextAreaField } },
);

export const EventForm = ({ asset, onSubmit }: FormProps & { readonly asset: Asset }) => {
  const k = useK();
  const required = useRequired();
  const [error, setError] = useState<string | undefined>();
  const command = ({ date, documentRef, kind, note }: typeof eventForm.schema.Encoded): OpsCommand | undefined => {
    if (note.trim() === '' || date === '') {
      setError(k(formText.required));
      return undefined;
    }
    setError(undefined);
    return {
      _tag: 'AssetEventRecord',
      assetId: asset.id,
      date,
      kind: manualEventKinds.find((entry) => entry === kind) ?? 'note',
      note: note.trim(),
      ...optional('documentRef', documentRef),
    };
  };
  return (
    <PanelForm
      command={command}
      error={error}
      form={eventForm}
      onSubmit={onSubmit}
      opened={{ date: todayIsoDate(), documentRef: '', kind: 'construction', note: '' }}
    >
      <ErrorLine message={error} />
      <FormGrid>
        <eventForm.kind
          items={manualEventKinds.map((entry) => ({ label: k(`event.${entry}`), value: entry }))}
          label={k('fields.eventKind')}
        />
        <eventForm.date {...textInput} {...required} id="event-date" label={k(formText.date)} type="date" />
      </FormGrid>
      <eventForm.note {...textArea} {...required} id="event-note" label={k('fields.description')} />
      <eventForm.documentRef
        {...textInput}
        helpText={k(formText.documentHelp)}
        id="event-document"
        label={k(formText.documentRef)}
      />
    </PanelForm>
  );
};

// ── Disposal (S02-04) ─────────────────────────────────────────────────────────────────────────────────

const disposeForm = FormReact.make(
  FormBuilder.empty
    .addField('date', Schema.String)
    .addField('documentRef', Schema.String)
    .addField('kind', Schema.String)
    .addField('proceeds', Schema.String)
    .addField('reason', Schema.String),
  {
    ...ledgerForm,
    fields: { date: TextField, documentRef: TextField, kind: ChoiceField, proceeds: TextField, reason: TextAreaField },
  },
);

const disposalKindOf = (value: string): DisposalKind => disposalKinds.find((entry) => entry === value) ?? 'retirement';

export const DisposeForm = ({ asset, onSubmit }: FormProps & { readonly asset: Asset }) => {
  const k = useK();
  const required = useRequired();
  const [error, setError] = useState<string | undefined>();
  const command = (values: typeof disposeForm.schema.Encoded): OpsCommand | undefined => {
    const { date, documentRef, proceeds, reason } = values;
    const kind = disposalKindOf(values.kind);
    const parsed = parseCzk(proceeds);
    if (parsed === null) {
      setError(k(formText.invalidAmount));
      return undefined;
    }
    if (reason.trim() === '' || date === '') {
      setError(k(formText.reasonRequired));
      return undefined;
    }
    setError(undefined);
    return {
      _tag: 'AssetDispose',
      assetId: asset.id,
      date,
      kind,
      reason: reason.trim(),
      ...optional('documentRef', documentRef),
      ...optionalField('proceedsMinor', kind === 'sale' ? parsed : undefined),
    };
  };
  return (
    <PanelForm
      command={command}
      error={error}
      form={disposeForm}
      onSubmit={onSubmit}
      opened={{ date: todayIsoDate(), documentRef: '', kind: 'retirement', proceeds: '', reason: '' }}
    >
      {(values) => (
        <>
          <p className="text-fg-secondary text-sm">{k('form.disposeIntro', { name: asset.name })}</p>
          <ErrorLine message={error} />
          <FormGrid>
            <disposeForm.kind
              items={disposalKinds.map((entry) => ({ label: k(`disposal.${entry}`), value: entry }))}
              label={k('fields.disposalKind')}
            />
            <disposeForm.date {...textInput} {...required} id="dispose-date" label={k(formText.date)} type="date" />
          </FormGrid>
          <disposeForm.reason {...textArea} {...required} id="dispose-reason" label={k('fields.reason')} />
          {disposalKindOf(values.kind) === 'sale' && (
            <disposeForm.proceeds
              {...textInput}
              helpText={k(formText.amountHelp)}
              id="dispose-proceeds"
              inputMode="decimal"
              label={k('fields.proceeds')}
            />
          )}
          <disposeForm.documentRef
            {...textInput}
            helpText={k(formText.documentHelp)}
            id="dispose-document"
            label={k(formText.documentRef)}
          />
        </>
      )}
    </PanelForm>
  );
};

// ── Revision / service / permit ───────────────────────────────────────────────────────────────────────

const serviceForm = FormReact.make(
  FormBuilder.empty
    .addField('documentRef', Schema.String)
    .addField('kind', Schema.String)
    .addField('nextDueOn', Schema.String)
    .addField('note', Schema.String)
    .addField('performedOn', Schema.String)
    .addField('permitState', Schema.String)
    .addField('responsible', Schema.String)
    .addField('result', Schema.String)
    .addField('supplier', Schema.String)
    .addField('title', Schema.String),
  {
    ...ledgerForm,
    fields: {
      documentRef: TextField,
      kind: ChoiceField,
      nextDueOn: TextField,
      note: TextAreaField,
      performedOn: TextField,
      permitState: ChoiceField,
      responsible: TextField,
      result: ChoiceField,
      supplier: TextField,
      title: TextField,
    },
  },
);

const serviceKindOf = (value: string): ServiceKind => serviceKinds.find((entry) => entry === value) ?? 'revision';

export const ServiceForm = ({ asset, onSubmit }: FormProps & { readonly asset: Asset }) => {
  const k = useK();
  const required = useRequired();
  const [error, setError] = useState<string | undefined>();
  const command = (values: typeof serviceForm.schema.Encoded): OpsCommand | undefined => {
    const { documentRef, nextDueOn, note, performedOn, responsible, supplier, title } = values;
    const kind = serviceKindOf(values.kind);
    const permitState = EffectOption.getOrElse(
      Schema.decodeUnknownOption(PermitStateSchema)(values.permitState),
      (): PermitState => 'requested',
    );
    const result = EffectOption.getOrElse(
      Schema.decodeUnknownOption(ServiceResultSchema)(values.result),
      (): ServiceResult => 'ok',
    );
    if (title.trim() === '') {
      setError(k(formText.required));
      return undefined;
    }
    if (kind !== 'permit' && performedOn === '' && nextDueOn === '') {
      setError(k('form.serviceDates'));
      return undefined;
    }
    setError(undefined);
    return {
      _tag: 'AssetServiceRecord',
      assetId: asset.id,
      kind,
      title: title.trim(),
      ...optional('performedOn', performedOn),
      ...optional('nextDueOn', nextDueOn),
      ...optional('supplier', supplier),
      ...optional('responsible', responsible),
      ...optional('documentRef', documentRef),
      ...optional('note', note),
      ...optionalField('permitState', kind === 'permit' ? permitState : undefined),
      ...optionalField('result', kind !== 'permit' && performedOn !== '' ? result : undefined),
    };
  };
  return (
    <PanelForm
      command={command}
      error={error}
      form={serviceForm}
      onSubmit={onSubmit}
      opened={{
        documentRef: '',
        kind: 'revision',
        nextDueOn: '',
        note: '',
        performedOn: todayIsoDate(),
        permitState: 'requested',
        responsible: asset.responsible ?? '',
        result: 'ok',
        supplier: '',
        title: '',
      }}
    >
      {(values) => {
        const permit = serviceKindOf(values.kind) === 'permit';
        return (
          <>
            <ErrorLine message={error} />
            <FormGrid>
              <serviceForm.kind
                items={serviceKinds.map((entry) => ({ label: k(`serviceKind.${entry}`), value: entry }))}
                label={k('fields.serviceKind')}
              />
              {permit ? (
                <serviceForm.permitState
                  items={['requested', 'in_progress', 'granted', 'rejected', 'expired'].map((entry) => ({
                    label: k(`permit.${entry}`),
                    value: entry,
                  }))}
                  label={k('fields.permitState')}
                />
              ) : (
                <serviceForm.result
                  items={['ok', 'defects', 'failed'].map((entry) => ({ label: k(`result.${entry}`), value: entry }))}
                  label={k('fields.result')}
                />
              )}
            </FormGrid>
            <serviceForm.title
              {...textInput}
              {...required}
              id="service-title"
              label={k('fields.serviceTitle')}
              placeholder={k('form.serviceTitlePlaceholder')}
            />
            <FormGrid>
              <serviceForm.performedOn
                {...textInput}
                id="service-performed"
                label={permit ? k('fields.permitDate') : k('fields.performedOn')}
                type="date"
              />
              <serviceForm.nextDueOn
                {...textInput}
                helpText={k('form.nextDueHelp')}
                id="service-next"
                label={permit ? k('fields.permitDeadline') : k('fields.nextDueOn')}
                type="date"
              />
            </FormGrid>
            <FormGrid>
              <serviceForm.supplier {...textInput} id="service-supplier" label={k('fields.supplier')} />
              <serviceForm.responsible {...textInput} id="service-responsible" label={k('fields.responsible')} />
            </FormGrid>
            <serviceForm.documentRef
              {...textInput}
              helpText={k(formText.documentHelp)}
              id="service-document"
              label={k(formText.documentRef)}
            />
            <serviceForm.note {...textArea} id="service-note" label={k(formText.note)} />
          </>
        );
      }}
    </PanelForm>
  );
};

// ── Depreciation plan (S03) ───────────────────────────────────────────────────────────────────────────

const planForm = FormReact.make(
  FormBuilder.empty
    .addField('base', Schema.String)
    .addField('method', Schema.String)
    .addField('note', Schema.String)
    .addField('planInterval', Schema.String)
    .addField('startDate', Schema.String)
    .addField('taxGroup', Schema.String)
    .addField('templateId', Schema.String)
    .addField('years', Schema.String),
  {
    ...ledgerForm,
    fields: {
      base: TextField,
      method: TextField,
      note: TextAreaField,
      planInterval: ChoiceField,
      startDate: TextField,
      taxGroup: TextField,
      templateId: ChoiceField,
      years: TextField,
    },
  },
);

const intervalOf = (value: string): DepreciationInterval => (value === 'monthly' ? 'monthly' : 'yearly');

/** The picked template as a plain string, which changes only when the pick does. */
const pickedTemplate = planForm
  .getFieldAtoms(planForm.fields.templateId)
  .value.pipe(Atom.map(EffectOption.getOrElse(() => NONE)));

export const PlanForm = ({
  asset,
  onSubmit,
  state,
  type,
}: FormProps & { readonly asset: Asset; readonly state: AssetsState; readonly type: DepreciationType }) => {
  const k = useK();
  const required = useRequired();
  const templates = (state.templates ?? []).filter((template) => template.type === type);
  const [error, setError] = useState<string | undefined>();
  const setMethod = useAtomSet(planForm.getFieldAtoms(planForm.fields.method).setValue);
  const setYears = useAtomSet(planForm.getFieldAtoms(planForm.fields.years).setValue);
  const setPlanInterval = useAtomSet(planForm.getFieldAtoms(planForm.fields.planInterval).setValue);
  const setTaxGroup = useAtomSet(planForm.getFieldAtoms(planForm.fields.taxGroup).setValue);
  // Picking a template fills in its method, years, interval and tax group.
  useAtomSubscribe(
    pickedTemplate,
    (id) => {
      const template = templates.find((entry) => entry.id === id);
      if (template !== undefined) {
        setMethod(template.method);
        setYears(String(template.years));
        setPlanInterval(template.interval);
        setTaxGroup(template.taxGroup ?? '');
      }
    },
    { immediate: false },
  );
  const command = (values: typeof planForm.schema.Encoded): OpsCommand | undefined => {
    const { base, method, note, startDate, taxGroup, years } = values;
    const templateId = values.templateId === '' ? NONE : values.templateId;
    const parsedBase = parseCzk(base);
    const parsedYears = Number(years);
    if (
      parsedBase === undefined ||
      parsedBase === null ||
      !Number.isInteger(parsedYears) ||
      parsedYears < 1 ||
      parsedYears > 100
    ) {
      setError(k('form.planInvalid'));
      return undefined;
    }
    if (method.trim() === '' || startDate === '') {
      setError(k(formText.required));
      return undefined;
    }
    setError(undefined);
    return {
      _tag: 'AssetDepreciationPlanCreate',
      assetId: asset.id,
      baseMinor: parsedBase,
      interval: intervalOf(values.planInterval),
      method: method.trim(),
      startDate,
      type,
      years: parsedYears,
      ...optional('taxGroup', type === 'tax' ? taxGroup : ''),
      ...optional('note', note),
      ...optionalField('templateId', templateId === NONE ? undefined : templateId),
    };
  };
  return (
    <PanelForm
      command={command}
      error={error}
      form={planForm}
      onSubmit={onSubmit}
      opened={{
        base: asset.acquisitionValueMinor === undefined ? '' : String(asset.acquisitionValueMinor / 100),
        method: 'Rovnoměrný',
        note: '',
        planInterval: 'yearly',
        startDate: asset.placedInServiceDate ?? asset.acquisitionDate ?? todayIsoDate(),
        taxGroup: '',
        templateId: NONE,
        years: '',
      }}
    >
      <p className="text-fg-secondary text-sm">{k('depreciation.evidenceNote')}</p>
      <ErrorLine message={error} />
      {templates.length > 0 && (
        <planForm.templateId
          items={[
            { label: k('form.noTemplate'), value: NONE },
            ...templates.map((entry) => ({ label: entry.name, value: entry.id })),
          ]}
          label={k('fields.template')}
        />
      )}
      <FormGrid>
        <planForm.method {...textInput} {...required} id="plan-method" label={k('fields.method')} maxLength={120} />
        {type === 'tax' ? (
          <planForm.taxGroup {...textInput} id="plan-tax-group" label={k('fields.taxGroup')} maxLength={40} />
        ) : (
          <span />
        )}
      </FormGrid>
      <FormGrid>
        <planForm.base
          {...textInput}
          {...required}
          helpText={k(formText.amountHelp)}
          id="plan-base"
          inputMode="decimal"
          label={k('fields.base')}
        />
        <planForm.startDate {...textInput} {...required} id="plan-start" label={k('fields.startDate')} type="date" />
      </FormGrid>
      <FormGrid>
        <planForm.years
          {...textInput}
          {...required}
          id="plan-years"
          inputMode="numeric"
          label={k('fields.years')}
          maxLength={3}
        />
        <planForm.planInterval
          items={[
            { label: k('interval.yearly'), value: 'yearly' },
            { label: k('interval.monthly'), value: 'monthly' },
          ]}
          label={k('fields.interval')}
        />
      </FormGrid>
      <planForm.note {...textArea} id="plan-note" label={k(formText.note)} />
    </PanelForm>
  );
};

/** Next period without an approved amount (indicative schedule order). */
const nextOpenPeriod = (plan: DepreciationPlan): string => {
  const taken = new Set(plan.entries.map((entry) => entry.period));
  return indicativeSchedule(plan).find((row) => !taken.has(row.period))?.period ?? '';
};

const entryForm = FormReact.make(
  FormBuilder.empty
    .addField('amount', Schema.String)
    .addField('documentRef', Schema.String)
    .addField('note', Schema.String)
    .addField('partial', Schema.Boolean)
    .addField('period', Schema.String),
  {
    ...ledgerForm,
    fields: {
      amount: TextField,
      documentRef: TextField,
      note: TextAreaField,
      partial: CheckboxField,
      period: TextField,
    },
  },
);

export const EntryForm = ({
  asset,
  onSubmit,
  plan,
}: FormProps & { readonly asset: Asset; readonly plan: DepreciationPlan }) => {
  const k = useK();
  const required = useRequired();
  const [error, setError] = useState<string | undefined>();
  const remaining = plan.baseMinor - approvedTotal(plan);
  const command = ({
    amount,
    documentRef,
    note,
    partial,
    period,
  }: typeof entryForm.schema.Encoded): OpsCommand | undefined => {
    const parsed = parseCzk(amount);
    const periodPattern = plan.interval === 'monthly' ? /^\d{4}-(?:0[1-9]|1[0-2])$/u : /^\d{4}$/u;
    if (!periodPattern.test(period.trim())) {
      setError(k(plan.interval === 'monthly' ? 'form.periodMonthly' : 'form.periodYearly'));
      return undefined;
    }
    if (parsed === undefined || parsed === null) {
      setError(k(formText.invalidAmount));
      return undefined;
    }
    if (parsed > remaining) {
      setError(k('form.overBase', { remaining: money(remaining, '—') }));
      return undefined;
    }
    if (plan.entries.some((entry) => entry.period === period.trim())) {
      setError(k('form.periodTaken'));
      return undefined;
    }
    setError(undefined);
    return {
      _tag: 'AssetDepreciationEntryRecord',
      amountMinor: parsed,
      assetId: asset.id,
      period: period.trim(),
      planId: plan.id,
      ...optional('documentRef', documentRef),
      ...optional('note', note),
      ...optionalField('partial', partial ? true : undefined),
    };
  };
  return (
    <PanelForm
      command={command}
      error={error}
      form={entryForm}
      onSubmit={onSubmit}
      opened={{ amount: '', documentRef: '', note: '', partial: false, period: nextOpenPeriod(plan) }}
    >
      <p className="text-fg-secondary text-sm">
        {k('form.entryIntro', { remaining: money(remaining, '—'), type: k(`depreciation.${plan.type}`) })}
      </p>
      <ErrorLine message={error} />
      <FormGrid>
        <entryForm.period
          {...textInput}
          {...required}
          helpText={k(plan.interval === 'monthly' ? 'form.periodMonthly' : 'form.periodYearly')}
          id="entry-period"
          label={k('fields.period')}
          maxLength={7}
        />
        <entryForm.amount
          {...textInput}
          {...required}
          helpText={k(formText.amountHelp)}
          id="entry-amount"
          inputMode="decimal"
          label={k('fields.approvedAmount')}
        />
      </FormGrid>
      <entryForm.documentRef
        {...textInput}
        helpText={k(formText.documentHelp)}
        id="entry-document"
        label={k(formText.documentRef)}
      />
      <entryForm.partial id="entry-partial" label={k('fields.partial')} />
      <entryForm.note {...textArea} id="entry-note" label={k(formText.note)} />
    </PanelForm>
  );
};

const templateForm = FormReact.make(
  FormBuilder.empty
    .addField('method', Schema.String)
    .addField('name', Schema.String)
    .addField('note', Schema.String)
    .addField('planInterval', Schema.String)
    .addField('taxGroup', Schema.String)
    .addField('type', Schema.String)
    .addField('years', Schema.String),
  {
    ...ledgerForm,
    fields: {
      method: TextField,
      name: TextField,
      note: TextAreaField,
      planInterval: ChoiceField,
      taxGroup: TextField,
      type: ChoiceField,
      years: TextField,
    },
  },
);

const depreciationTypeOf = (value: string): DepreciationType => (value === 'tax' ? 'tax' : 'accounting');

export const TemplateForm = ({ onSubmit }: FormProps) => {
  const k = useK();
  const required = useRequired();
  const [error, setError] = useState<string | undefined>();
  const command = (values: typeof templateForm.schema.Encoded): OpsCommand | undefined => {
    const { method, name, note, taxGroup, years } = values;
    const type = depreciationTypeOf(values.type);
    const parsedYears = Number(years);
    if (
      name.trim() === '' ||
      method.trim() === '' ||
      !Number.isInteger(parsedYears) ||
      parsedYears < 1 ||
      parsedYears > 100
    ) {
      setError(k('form.planInvalid'));
      return undefined;
    }
    setError(undefined);
    return {
      _tag: 'AssetDepreciationTemplateCreate',
      interval: intervalOf(values.planInterval),
      method: method.trim(),
      name: name.trim(),
      type,
      years: parsedYears,
      ...optional('taxGroup', type === 'tax' ? taxGroup : ''),
      ...optional('note', note),
    };
  };
  return (
    <PanelForm
      command={command}
      error={error}
      form={templateForm}
      onSubmit={onSubmit}
      opened={{
        method: 'Rovnoměrný',
        name: '',
        note: '',
        planInterval: 'yearly',
        taxGroup: '',
        type: 'accounting',
        years: '',
      }}
    >
      {(values) => (
        <>
          <p className="text-fg-secondary text-sm">{k('templates.intro')}</p>
          <ErrorLine message={error} />
          <templateForm.name {...textInput} {...required} id="template-name" label={k('fields.templateName')} />
          <FormGrid>
            <templateForm.type
              items={[
                { label: k('depreciation.accounting'), value: 'accounting' },
                { label: k('depreciation.tax'), value: 'tax' },
              ]}
              label={k('fields.planType')}
            />
            <templateForm.method {...textInput} {...required} id="template-method" label={k('fields.method')} />
          </FormGrid>
          <FormGrid>
            <templateForm.years
              {...textInput}
              {...required}
              id="template-years"
              inputMode="numeric"
              label={k('fields.years')}
              maxLength={3}
            />
            <templateForm.planInterval
              items={[
                { label: k('interval.yearly'), value: 'yearly' },
                { label: k('interval.monthly'), value: 'monthly' },
              ]}
              label={k('fields.interval')}
            />
          </FormGrid>
          {depreciationTypeOf(values.type) === 'tax' && (
            <templateForm.taxGroup {...textInput} id="template-tax-group" label={k('fields.taxGroup')} />
          )}
          <templateForm.note {...textArea} id="template-note" label={k(formText.note)} />
        </>
      )}
    </PanelForm>
  );
};

// ── Inventory (S02 inventura) ─────────────────────────────────────────────────────────────────────────

const inventoryForm = FormReact.make(
  FormBuilder.empty
    .addField('date', Schema.String)
    .addField('note', Schema.String)
    .addField('scope', Schema.String)
    .addField('title', Schema.String),
  { ...ledgerForm, fields: { date: TextField, note: TextAreaField, scope: ChoiceField, title: TextField } },
);

/** A new inventory: of the whole company, dated today. */
const inventoryOpened = () => ({ date: todayIsoDate(), note: '', scope: NONE, title: '' });

/** The picked scope as a plain string, which changes only when the pick does. */
const pickedScope = inventoryForm
  .getFieldAtoms(inventoryForm.fields.scope)
  .value.pipe(Atom.map(EffectOption.getOrElse(() => NONE)));

export const InventoryCreateForm = ({ onSubmit, state }: FormProps & { readonly state: AssetsState }) => {
  const k = useK();
  const required = useRequired();
  const tree = usePropertyTree();
  const [error, setError] = useState<string | undefined>();
  const properties = tree.status === 'ready' ? tree.nodes : [];
  const opened = inventoryOpened();
  // The title and date the scope's name goes with, as they are now.
  const current = EffectOption.getOrElse(useAtomValue(inventoryForm.values), () => opened);
  const setTitle = useAtomSet(inventoryForm.getFieldAtoms(inventoryForm.fields.title).setValue);
  // Picking a scope names an untitled inventory (or one still named after the previous scope) after it.
  useAtomSubscribe(
    pickedScope,
    (value) => {
      const node = properties.find((entry) => entry.ref.id === value);
      if (current.title.trim() === '' || current.title.startsWith(k('inventory.defaultTitlePrefix'))) {
        setTitle(
          `${k('inventory.defaultTitlePrefix')} ${current.date.slice(0, 4)} – ${node?.ref.label.replace(/ \([^)]*\)$/u, '') ?? k('inventory.wholeCompany')}`,
        );
      }
    },
    { immediate: false },
  );
  const candidatesOf = (scopeValue: string) => {
    const scope = scopeValue === NONE ? '' : scopeValue;
    return state.assets.filter(
      (asset) => isActiveAsset(asset) && (scope === '' || asset.propertyId === scope || asset.location?.id === scope),
    );
  };
  const command = ({ date, note, scope, title }: typeof inventoryForm.schema.Encoded): OpsCommand | undefined => {
    const candidates = candidatesOf(scope);
    const picked = properties.find((node) => node.ref.id === scope);
    if (title.trim() === '' || date === '') {
      setError(k(formText.required));
      return undefined;
    }
    if (candidates.length === 0) {
      setError(k('inventory.noCandidates'));
      return undefined;
    }
    setError(undefined);
    return {
      _tag: 'AssetInventoryCreate',
      assetIds: candidates.map((asset) => asset.id),
      date,
      title: title.trim(),
      ...optional('note', note),
      ...optionalField('scope', picked?.ref),
    };
  };
  return (
    <PanelForm command={command} error={error} form={inventoryForm} onSubmit={onSubmit} opened={opened}>
      {(values) => {
        const candidates = candidatesOf(values.scope);
        return (
          <>
            <p className="text-fg-secondary text-sm">{k('inventory.createIntro')}</p>
            <ErrorLine message={error} />
            <inventoryForm.scope
              items={[
                { label: k('inventory.wholeCompany'), value: NONE },
                ...properties.map((node) => ({ label: node.ref.label, value: node.ref.id })),
              ]}
              label={k('fields.inventoryScope')}
            />
            <FormGrid>
              <inventoryForm.title
                {...textInput}
                {...required}
                id="inventory-title"
                label={k('fields.inventoryTitle')}
              />
              <inventoryForm.date
                {...textInput}
                {...required}
                id="inventory-date"
                label={k(formText.date)}
                type="date"
              />
            </FormGrid>
            <inventoryForm.note {...textArea} id="inventory-note" label={k(formText.note)} />
            <div className={`${surfaceTileClassName} p-150 text-sm`}>
              <p className="font-medium">{k('inventory.candidates', { count: candidates.length })}</p>
              <ul className="mt-100 flex max-h-[14rem] flex-col gap-50 overflow-auto text-fg-secondary">
                {candidates.map((asset) => (
                  <li key={asset.id}>
                    <span className="tabular-nums">{asset.inventoryNumber}</span> · {asset.name}
                  </li>
                ))}
              </ul>
            </div>
          </>
        );
      }}
    </PanelForm>
  );
};

const followUpForm = FormReact.make(
  FormBuilder.empty
    .addField('assignee', Schema.String)
    .addField('dueDate', Schema.String)
    .addField('title', Schema.String),
  { ...ledgerForm, fields: { assignee: TextField, dueDate: TextField, title: TextField } },
);

export const FollowUpForm = ({
  assetId,
  assetName,
  inventoryId,
  onSubmit,
}: FormProps & { readonly assetId: Asset['id']; readonly assetName: string; readonly inventoryId: string }) => {
  const k = useK();
  const required = useRequired();
  const [error, setError] = useState<string | undefined>();
  const command = ({ assignee, dueDate, title }: typeof followUpForm.schema.Encoded): OpsCommand | undefined => {
    if (title.trim() === '' || dueDate === '') {
      setError(k(formText.required));
      return undefined;
    }
    setError(undefined);
    return {
      _tag: 'AssetInventoryFollowUp',
      assetId,
      dueDate,
      inventoryId,
      title: title.trim(),
      ...optional('assignee', assignee),
    };
  };
  return (
    <PanelForm
      command={command}
      error={error}
      form={followUpForm}
      onSubmit={onSubmit}
      opened={{ assignee: '', dueDate: todayIsoDate(), title: k('inventory.followUpDefault', { name: assetName }) }}
      savableAtOnce
    >
      <ErrorLine message={error} />
      <followUpForm.title {...textInput} {...required} id="followup-title" label={k('fields.taskTitle')} />
      <FormGrid>
        <followUpForm.dueDate {...textInput} {...required} id="followup-due" label={k('fields.dueDate')} type="date" />
        <followUpForm.assignee {...textInput} id="followup-assignee" label={k('fields.assignee')} />
      </FormGrid>
    </PanelForm>
  );
};

const archiveForm = FormReact.make(FormBuilder.empty.addField('reason', Schema.String), {
  ...ledgerForm,
  fields: { reason: TextField },
});

export const ArchiveForm = ({ asset, onSubmit }: FormProps & { readonly asset: Asset }) => {
  const k = useK();
  const required = useRequired();
  const [error, setError] = useState<string | undefined>();
  const command = ({ reason }: typeof archiveForm.schema.Encoded): OpsCommand | undefined => {
    const trimmed = reason.trim();
    if (trimmed === '') {
      setError(k(formText.reasonRequired));
      return undefined;
    }
    setError(undefined);
    return { _tag: 'AssetArchive', assetId: asset.id, reason: trimmed };
  };
  return (
    <PanelForm
      command={command}
      error={error}
      form={archiveForm}
      onSubmit={onSubmit}
      opened={{ reason: k('archive.defaultReason') }}
      savableAtOnce
    >
      <ErrorLine message={error} />
      <archiveForm.reason {...textInput} {...required} id="asset-archive-reason" label={k('archive.prompt')} />
    </PanelForm>
  );
};
