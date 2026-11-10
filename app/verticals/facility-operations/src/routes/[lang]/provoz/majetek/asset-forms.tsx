// Forms of the assets page. Each keeps its draft and renders the shared Uložit last in the SidePanel footer, which
// builds a typed command and runs it through the panel's `onSubmit` (the governed apply-command Action). The create/edit card keeps
// its values in the page's draft, so an edit of a stored asset is sent by the panel's Uložit. Owned by ops-assets.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Option as EffectOption, Schema } from 'effect';
import type { TOptions } from 'i18next';
import { useState } from 'react';
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
import {
  assetCardCreateCommandOf,
  assetCardDraftOf,
  assetCardProblems,
  assetCardUpdateCommandOf,
} from './asset-card-draft.ts';
import type { AssetCardDraft } from './asset-card-draft.ts';
import { money, parseCzk, todayIsoDate } from './assets-model.ts';
import {
  AreaField,
  CheckField,
  ErrorLine,
  FormGrid,
  PanelFields,
  PanelForm,
  SelectField,
  TextField,
  optional,
} from './form-kit.tsx';
import type { AssetSubmit, Option } from './form-kit.tsx';
import { assetPlacementOf, locationItems, usePropertyTree } from './property-tree.ts';
import type { PropertyTree } from './property-tree.ts';
import { surfaceTileClassName } from '@app/admin-ui';

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

// ── Create / edit card ──────────────────────────────────────────────────────────────────────────────────

export interface AssetCardFormProps {
  readonly asset?: Asset;
  readonly draft: AssetCardDraft;
  /** The page owns the draft, so an edit is saved from the panel footer. */
  readonly onChange: (patch: Partial<AssetCardDraft>) => void;
  /** A new card only: its Uložit creates it. An edit is saved by the panel's own save bar. */
  readonly onSubmit?: AssetSubmit | undefined;
  readonly state: AssetsState;
}

export const AssetCardForm = ({ asset, draft, onChange, onSubmit, state }: AssetCardFormProps) => {
  const k = useK();
  const tree = usePropertyTree();
  const [error, setError] = useState<string | undefined>();
  const problems = assetCardProblems(draft);

  const command = (): OpsCommand | undefined => {
    if (problems.inventoryNumber || problems.name || problems.category) {
      setError(k(formText.required));
      return undefined;
    }
    if (
      asset === undefined &&
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
    const built =
      asset === undefined
        ? assetCardCreateCommandOf(draft, assetPlacementOf(tree, draft))
        : assetCardUpdateCommandOf(draft, asset, assetPlacementOf(tree, draft, asset));
    return EffectOption.getOrUndefined(built);
  };

  const fields = (
    <>
      <ErrorLine message={error} />
      <FormGrid>
        <TextField
          id="asset-inventory-number"
          invalid={problems.inventoryNumber}
          label={k('fields.inventoryNumber')}
          maxLength={64}
          onChange={(value) => onChange({ inventoryNumber: value })}
          required
          value={draft.inventoryNumber}
          {...(asset === undefined ? {} : { helpText: k('form.numberFixed') })}
        />
        <SelectField
          label={k('fields.kind')}
          name="kind"
          onChange={(value) => onChange({ kind: assetKinds.find((entry) => entry === value) ?? 'equipment' })}
          options={assetKinds.map((entry) => ({ label: k(`kind.${entry}`), value: entry }))}
          value={draft.kind}
        />
      </FormGrid>
      <TextField
        id="asset-name"
        invalid={problems.name}
        label={k('fields.name')}
        onChange={(value) => onChange({ name: value })}
        required
        value={draft.name}
      />
      <FormGrid>
        <TextField
          id="asset-category"
          invalid={problems.category}
          label={k('fields.category')}
          maxLength={120}
          onChange={(value) => onChange({ category: value })}
          placeholder={k('form.categoryPlaceholder')}
          required
          value={draft.category}
        />
        <TextField
          id="asset-serial"
          label={k('fields.serialNumber')}
          maxLength={120}
          onChange={(value) => onChange({ serialNumber: value })}
          value={draft.serialNumber}
        />
      </FormGrid>
      <SelectField
        label={k('fields.location')}
        name="location"
        onChange={(value) => onChange({ location: value === NONE ? '' : value })}
        options={locationOptions(tree, k('form.noLocation'))}
        value={draft.location === '' ? NONE : draft.location}
      />
      {tree.status === 'failed' && <ErrorLine message={k('form.propertiesFailed')} />}
      <TextField
        id="asset-responsible"
        label={k('fields.responsible')}
        onChange={(value) => onChange({ responsible: value })}
        value={draft.responsible}
      />
      {asset === undefined && (
        <>
          <FormGrid>
            <TextField
              id="asset-acquisition-date"
              label={k('fields.acquisitionDate')}
              onChange={(value) => onChange({ acquisitionDateInput: value })}
              type="date"
              value={draft.acquisitionDateInput}
            />
            <SelectField
              label={k('fields.acquisitionMethod')}
              name="acquisitionMethod"
              onChange={(value) =>
                onChange({ acquisitionMethod: acquisitionMethods.find((entry) => entry === value) ?? 'purchase' })
              }
              options={acquisitionMethods.map((entry) => ({ label: k(`method.${entry}`), value: entry }))}
              value={draft.acquisitionMethod}
            />
          </FormGrid>
          <FormGrid>
            <TextField
              helpText={k(formText.amountHelp)}
              id="asset-acquisition-value"
              inputMode="decimal"
              invalid={problems.amount}
              label={k('fields.acquisitionValue')}
              onChange={(value) => onChange({ acquisitionValue: value })}
              value={draft.acquisitionValue}
            />
            <TextField
              id="asset-in-service"
              label={k('fields.placedInService')}
              onChange={(value) => onChange({ placedInServiceDateInput: value })}
              type="date"
              value={draft.placedInServiceDateInput}
            />
          </FormGrid>
        </>
      )}
      <TextField
        helpText={k('form.accountingProductHelp')}
        id="asset-accounting-product"
        label={k('fields.accountingProduct')}
        onChange={(value) => onChange({ accountingProduct: value })}
        value={draft.accountingProduct}
      />
      <AreaField
        id="asset-note"
        label={k(formText.note)}
        onChange={(value) => onChange({ note: value })}
        value={draft.note}
      />
    </>
  );
  return onSubmit === undefined ? (
    <PanelFields>{fields}</PanelFields>
  ) : (
    <PanelForm command={command} error={error} onSubmit={onSubmit} value={draft}>
      {fields}
    </PanelForm>
  );
};

/** A new asset card: its draft is local, and the footer's Uložit creates the asset once. */
export const AssetCardCreateForm = ({ onSubmit, state }: FormProps & { readonly state: AssetsState }) => {
  const [draft, setDraft] = useState<AssetCardDraft>(() => assetCardDraftOf());
  const change = (patch: Partial<AssetCardDraft>) => setDraft((current) => ({ ...current, ...patch }));
  return <AssetCardForm draft={draft} onChange={change} onSubmit={onSubmit} state={state} />;
};

// ── Value change (S02-02) ─────────────────────────────────────────────────────────────────────────────

export const ValueChangeForm = ({ asset, onSubmit }: FormProps & { readonly asset: Asset }) => {
  const k = useK();
  const [value, setValue] = useState('');
  const [date, setDate] = useState(todayIsoDate);
  const [reason, setReason] = useState('');
  const [documentRef, setDocumentRef] = useState('');
  const [error, setError] = useState<string | undefined>();
  const command = (): OpsCommand | undefined => {
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
    <PanelForm command={command} error={error} onSubmit={onSubmit} value={{ date, documentRef, reason, value }}>
      <p className="text-fg-secondary text-sm">
        {k('form.valueIntro', { value: money(asset.currentValueMinor, k('notProvided')) })}
      </p>
      <ErrorLine message={error} />
      <FormGrid>
        <TextField
          helpText={k(formText.amountHelp)}
          id="value-new"
          inputMode="decimal"
          label={k('fields.newValue')}
          onChange={setValue}
          required
          value={value}
        />
        <TextField id="value-date" label={k('fields.valueDate')} onChange={setDate} required type="date" value={date} />
      </FormGrid>
      <AreaField
        helpText={k('form.reasonHelp')}
        id="value-reason"
        label={k('fields.reason')}
        onChange={setReason}
        required
        value={reason}
      />
      <TextField
        helpText={k(formText.documentHelp)}
        id="value-document"
        label={k(formText.documentRef)}
        onChange={setDocumentRef}
        value={documentRef}
      />
    </PanelForm>
  );
};

// ── Timeline event ────────────────────────────────────────────────────────────────────────────────────

export const EventForm = ({ asset, onSubmit }: FormProps & { readonly asset: Asset }) => {
  const k = useK();
  const [kind, setKind] = useState<(typeof manualEventKinds)[number]>('construction');
  const [date, setDate] = useState(todayIsoDate);
  const [note, setNote] = useState('');
  const [documentRef, setDocumentRef] = useState('');
  const [error, setError] = useState<string | undefined>();
  const command = (): OpsCommand | undefined => {
    if (note.trim() === '' || date === '') {
      setError(k(formText.required));
      return undefined;
    }
    setError(undefined);
    return {
      _tag: 'AssetEventRecord',
      assetId: asset.id,
      date,
      kind,
      note: note.trim(),
      ...optional('documentRef', documentRef),
    };
  };
  return (
    <PanelForm command={command} error={error} onSubmit={onSubmit} value={{ date, documentRef, kind, note }}>
      <ErrorLine message={error} />
      <FormGrid>
        <SelectField
          label={k('fields.eventKind')}
          name="eventKind"
          onChange={(value) => setKind(manualEventKinds.find((entry) => entry === value) ?? 'note')}
          options={manualEventKinds.map((entry) => ({ label: k(`event.${entry}`), value: entry }))}
          value={kind}
        />
        <TextField id="event-date" label={k(formText.date)} onChange={setDate} required type="date" value={date} />
      </FormGrid>
      <AreaField id="event-note" label={k('fields.description')} onChange={setNote} required value={note} />
      <TextField
        helpText={k(formText.documentHelp)}
        id="event-document"
        label={k(formText.documentRef)}
        onChange={setDocumentRef}
        value={documentRef}
      />
    </PanelForm>
  );
};

// ── Disposal (S02-04) ─────────────────────────────────────────────────────────────────────────────────

export const DisposeForm = ({ asset, onSubmit }: FormProps & { readonly asset: Asset }) => {
  const k = useK();
  const [kind, setKind] = useState<DisposalKind>('retirement');
  const [date, setDate] = useState(todayIsoDate);
  const [reason, setReason] = useState('');
  const [proceeds, setProceeds] = useState('');
  const [documentRef, setDocumentRef] = useState('');
  const [error, setError] = useState<string | undefined>();
  const command = (): OpsCommand | undefined => {
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
      onSubmit={onSubmit}
      value={{ date, documentRef, kind, proceeds, reason }}
    >
      <p className="text-fg-secondary text-sm">{k('form.disposeIntro', { name: asset.name })}</p>
      <ErrorLine message={error} />
      <FormGrid>
        <SelectField
          label={k('fields.disposalKind')}
          name="disposalKind"
          onChange={(value) => setKind(disposalKinds.find((entry) => entry === value) ?? 'retirement')}
          options={disposalKinds.map((entry) => ({ label: k(`disposal.${entry}`), value: entry }))}
          value={kind}
        />
        <TextField id="dispose-date" label={k(formText.date)} onChange={setDate} required type="date" value={date} />
      </FormGrid>
      <AreaField id="dispose-reason" label={k('fields.reason')} onChange={setReason} required value={reason} />
      {kind === 'sale' && (
        <TextField
          helpText={k(formText.amountHelp)}
          id="dispose-proceeds"
          inputMode="decimal"
          label={k('fields.proceeds')}
          onChange={setProceeds}
          value={proceeds}
        />
      )}
      <TextField
        helpText={k(formText.documentHelp)}
        id="dispose-document"
        label={k(formText.documentRef)}
        onChange={setDocumentRef}
        value={documentRef}
      />
    </PanelForm>
  );
};

// ── Revision / service / permit ───────────────────────────────────────────────────────────────────────

export const ServiceForm = ({ asset, onSubmit }: FormProps & { readonly asset: Asset }) => {
  const k = useK();
  const [kind, setKind] = useState<ServiceKind>('revision');
  const [title, setTitle] = useState('');
  const [performedOn, setPerformedOn] = useState(todayIsoDate);
  const [nextDueOn, setNextDueOn] = useState('');
  const [supplier, setSupplier] = useState('');
  const [responsible, setResponsible] = useState(() => asset.responsible ?? '');
  const [result, setResult] = useState<ServiceResult>('ok');
  const [permitState, setPermitState] = useState<PermitState>('requested');
  const [documentRef, setDocumentRef] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | undefined>();
  const command = (): OpsCommand | undefined => {
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
      onSubmit={onSubmit}
      value={{ documentRef, kind, nextDueOn, note, performedOn, permitState, responsible, result, supplier, title }}
    >
      <ErrorLine message={error} />
      <FormGrid>
        <SelectField
          label={k('fields.serviceKind')}
          name="serviceKind"
          onChange={(value) => setKind(serviceKinds.find((entry) => entry === value) ?? 'revision')}
          options={serviceKinds.map((entry) => ({ label: k(`serviceKind.${entry}`), value: entry }))}
          value={kind}
        />
        {kind === 'permit' ? (
          <SelectField
            label={k('fields.permitState')}
            name="permitState"
            onChange={(value) =>
              setPermitState(
                EffectOption.getOrElse(
                  Schema.decodeUnknownOption(PermitStateSchema)(value),
                  (): PermitState => 'requested',
                ),
              )
            }
            options={['requested', 'in_progress', 'granted', 'rejected', 'expired'].map((entry) => ({
              label: k(`permit.${entry}`),
              value: entry,
            }))}
            value={permitState}
          />
        ) : (
          <SelectField
            label={k('fields.result')}
            name="result"
            onChange={(value) =>
              setResult(
                EffectOption.getOrElse(
                  Schema.decodeUnknownOption(ServiceResultSchema)(value),
                  (): ServiceResult => 'ok',
                ),
              )
            }
            options={['ok', 'defects', 'failed'].map((entry) => ({ label: k(`result.${entry}`), value: entry }))}
            value={result}
          />
        )}
      </FormGrid>
      <TextField
        id="service-title"
        label={k('fields.serviceTitle')}
        onChange={setTitle}
        placeholder={k('form.serviceTitlePlaceholder')}
        required
        value={title}
      />
      <FormGrid>
        <TextField
          id="service-performed"
          label={kind === 'permit' ? k('fields.permitDate') : k('fields.performedOn')}
          onChange={setPerformedOn}
          type="date"
          value={performedOn}
        />
        <TextField
          helpText={k('form.nextDueHelp')}
          id="service-next"
          label={kind === 'permit' ? k('fields.permitDeadline') : k('fields.nextDueOn')}
          onChange={setNextDueOn}
          type="date"
          value={nextDueOn}
        />
      </FormGrid>
      <FormGrid>
        <TextField id="service-supplier" label={k('fields.supplier')} onChange={setSupplier} value={supplier} />
        <TextField
          id="service-responsible"
          label={k('fields.responsible')}
          onChange={setResponsible}
          value={responsible}
        />
      </FormGrid>
      <TextField
        helpText={k(formText.documentHelp)}
        id="service-document"
        label={k(formText.documentRef)}
        onChange={setDocumentRef}
        value={documentRef}
      />
      <AreaField id="service-note" label={k(formText.note)} onChange={setNote} value={note} />
    </PanelForm>
  );
};

// ── Depreciation plan (S03) ───────────────────────────────────────────────────────────────────────────

export const PlanForm = ({
  asset,
  onSubmit,
  state,
  type,
}: FormProps & { readonly asset: Asset; readonly state: AssetsState; readonly type: DepreciationType }) => {
  const k = useK();
  const templates = (state.templates ?? []).filter((template) => template.type === type);
  const [templateId, setTemplateId] = useState(NONE);
  const [method, setMethod] = useState('Rovnoměrný');
  const [years, setYears] = useState('');
  const [planInterval, setPlanInterval] = useState<DepreciationInterval>('yearly');
  const [taxGroup, setTaxGroup] = useState('');
  const [base, setBase] = useState(() =>
    asset.acquisitionValueMinor === undefined ? '' : String(asset.acquisitionValueMinor / 100),
  );
  const [startDate, setStartDate] = useState(
    () => asset.placedInServiceDate ?? asset.acquisitionDate ?? todayIsoDate(),
  );
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | undefined>();
  const applyTemplate = (id: string) => {
    setTemplateId(id);
    const template = templates.find((entry) => entry.id === id);
    if (template !== undefined) {
      setMethod(template.method);
      setYears(String(template.years));
      setPlanInterval(template.interval);
      setTaxGroup(template.taxGroup ?? '');
    }
  };
  const command = (): OpsCommand | undefined => {
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
      interval: planInterval,
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
      onSubmit={onSubmit}
      value={{ base, method, note, planInterval, startDate, taxGroup, templateId, years }}
    >
      <p className="text-fg-secondary text-sm">{k('depreciation.evidenceNote')}</p>
      <ErrorLine message={error} />
      {templates.length > 0 && (
        <SelectField
          label={k('fields.template')}
          name="template"
          onChange={(value) => applyTemplate(value === '' ? NONE : value)}
          options={[
            { label: k('form.noTemplate'), value: NONE },
            ...templates.map((entry) => ({ label: entry.name, value: entry.id })),
          ]}
          value={templateId}
        />
      )}
      <FormGrid>
        <TextField
          id="plan-method"
          label={k('fields.method')}
          maxLength={120}
          onChange={setMethod}
          required
          value={method}
        />
        {type === 'tax' ? (
          <TextField
            id="plan-tax-group"
            label={k('fields.taxGroup')}
            maxLength={40}
            onChange={setTaxGroup}
            value={taxGroup}
          />
        ) : (
          <span />
        )}
      </FormGrid>
      <FormGrid>
        <TextField
          helpText={k(formText.amountHelp)}
          id="plan-base"
          inputMode="decimal"
          label={k('fields.base')}
          onChange={setBase}
          required
          value={base}
        />
        <TextField
          id="plan-start"
          label={k('fields.startDate')}
          onChange={setStartDate}
          required
          type="date"
          value={startDate}
        />
      </FormGrid>
      <FormGrid>
        <TextField
          id="plan-years"
          inputMode="numeric"
          label={k('fields.years')}
          maxLength={3}
          onChange={setYears}
          required
          value={years}
        />
        <SelectField
          label={k('fields.interval')}
          name="interval"
          onChange={(value) => setPlanInterval(value === 'monthly' ? 'monthly' : 'yearly')}
          options={[
            { label: k('interval.yearly'), value: 'yearly' },
            { label: k('interval.monthly'), value: 'monthly' },
          ]}
          value={planInterval}
        />
      </FormGrid>
      <AreaField id="plan-note" label={k(formText.note)} onChange={setNote} value={note} />
    </PanelForm>
  );
};

/** Next period without an approved amount (indicative schedule order). */
const nextOpenPeriod = (plan: DepreciationPlan): string => {
  const taken = new Set(plan.entries.map((entry) => entry.period));
  return indicativeSchedule(plan).find((row) => !taken.has(row.period))?.period ?? '';
};

export const EntryForm = ({
  asset,
  onSubmit,
  plan,
}: FormProps & { readonly asset: Asset; readonly plan: DepreciationPlan }) => {
  const k = useK();
  const [period, setPeriod] = useState(() => nextOpenPeriod(plan));
  const [amount, setAmount] = useState('');
  const [documentRef, setDocumentRef] = useState('');
  const [partial, setPartial] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | undefined>();
  const remaining = plan.baseMinor - approvedTotal(plan);
  const command = (): OpsCommand | undefined => {
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
      onSubmit={onSubmit}
      value={{ amount, documentRef, note, partial, period }}
    >
      <p className="text-fg-secondary text-sm">
        {k('form.entryIntro', { remaining: money(remaining, '—'), type: k(`depreciation.${plan.type}`) })}
      </p>
      <ErrorLine message={error} />
      <FormGrid>
        <TextField
          helpText={k(plan.interval === 'monthly' ? 'form.periodMonthly' : 'form.periodYearly')}
          id="entry-period"
          label={k('fields.period')}
          maxLength={7}
          onChange={setPeriod}
          required
          value={period}
        />
        <TextField
          helpText={k(formText.amountHelp)}
          id="entry-amount"
          inputMode="decimal"
          label={k('fields.approvedAmount')}
          onChange={setAmount}
          required
          value={amount}
        />
      </FormGrid>
      <TextField
        helpText={k(formText.documentHelp)}
        id="entry-document"
        label={k(formText.documentRef)}
        onChange={setDocumentRef}
        value={documentRef}
      />
      <CheckField checked={partial} id="entry-partial" label={k('fields.partial')} onChange={setPartial} />
      <AreaField id="entry-note" label={k(formText.note)} onChange={setNote} value={note} />
    </PanelForm>
  );
};

export const TemplateForm = ({ onSubmit }: FormProps) => {
  const k = useK();
  const [name, setName] = useState('');
  const [type, setType] = useState<DepreciationType>('accounting');
  const [method, setMethod] = useState('Rovnoměrný');
  const [years, setYears] = useState('');
  const [planInterval, setPlanInterval] = useState<DepreciationInterval>('yearly');
  const [taxGroup, setTaxGroup] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | undefined>();
  const command = (): OpsCommand | undefined => {
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
      interval: planInterval,
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
      onSubmit={onSubmit}
      value={{ method, name, note, planInterval, taxGroup, type, years }}
    >
      <p className="text-fg-secondary text-sm">{k('templates.intro')}</p>
      <ErrorLine message={error} />
      <TextField id="template-name" label={k('fields.templateName')} onChange={setName} required value={name} />
      <FormGrid>
        <SelectField
          label={k('fields.planType')}
          name="planType"
          onChange={(value) => setType(value === 'tax' ? 'tax' : 'accounting')}
          options={[
            { label: k('depreciation.accounting'), value: 'accounting' },
            { label: k('depreciation.tax'), value: 'tax' },
          ]}
          value={type}
        />
        <TextField id="template-method" label={k('fields.method')} onChange={setMethod} required value={method} />
      </FormGrid>
      <FormGrid>
        <TextField
          id="template-years"
          inputMode="numeric"
          label={k('fields.years')}
          maxLength={3}
          onChange={setYears}
          required
          value={years}
        />
        <SelectField
          label={k('fields.interval')}
          name="templateInterval"
          onChange={(value) => setPlanInterval(value === 'monthly' ? 'monthly' : 'yearly')}
          options={[
            { label: k('interval.yearly'), value: 'yearly' },
            { label: k('interval.monthly'), value: 'monthly' },
          ]}
          value={planInterval}
        />
      </FormGrid>
      {type === 'tax' && (
        <TextField id="template-tax-group" label={k('fields.taxGroup')} onChange={setTaxGroup} value={taxGroup} />
      )}
      <AreaField id="template-note" label={k(formText.note)} onChange={setNote} value={note} />
    </PanelForm>
  );
};

// ── Inventory (S02 inventura) ─────────────────────────────────────────────────────────────────────────

export const InventoryCreateForm = ({ onSubmit, state }: FormProps & { readonly state: AssetsState }) => {
  const k = useK();
  const tree = usePropertyTree();
  const [scope, setScope] = useState('');
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(todayIsoDate);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | undefined>();
  const properties = tree.status === 'ready' ? tree.nodes : [];
  const picked = properties.find((node) => node.ref.id === scope);
  const candidates = state.assets.filter(
    (asset) => isActiveAsset(asset) && (scope === '' || asset.propertyId === scope || asset.location?.id === scope),
  );
  const command = (): OpsCommand | undefined => {
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
    <PanelForm command={command} error={error} onSubmit={onSubmit} value={{ date, note, scope, title }}>
      <p className="text-fg-secondary text-sm">{k('inventory.createIntro')}</p>
      <ErrorLine message={error} />
      <SelectField
        label={k('fields.inventoryScope')}
        name="inventoryScope"
        onChange={(value) => {
          setScope(value === NONE ? '' : value);
          const node = properties.find((entry) => entry.ref.id === value);
          if (title.trim() === '' || title.startsWith(k('inventory.defaultTitlePrefix'))) {
            setTitle(
              `${k('inventory.defaultTitlePrefix')} ${date.slice(0, 4)} – ${node?.ref.label.replace(/ \([^)]*\)$/u, '') ?? k('inventory.wholeCompany')}`,
            );
          }
        }}
        options={[
          { label: k('inventory.wholeCompany'), value: NONE },
          ...properties.map((node) => ({ label: node.ref.label, value: node.ref.id })),
        ]}
        value={scope === '' ? NONE : scope}
      />
      <FormGrid>
        <TextField id="inventory-title" label={k('fields.inventoryTitle')} onChange={setTitle} required value={title} />
        <TextField id="inventory-date" label={k(formText.date)} onChange={setDate} required type="date" value={date} />
      </FormGrid>
      <AreaField id="inventory-note" label={k(formText.note)} onChange={setNote} value={note} />
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
    </PanelForm>
  );
};

export const FollowUpForm = ({
  assetId,
  assetName,
  inventoryId,
  onSubmit,
}: FormProps & { readonly assetId: Asset['id']; readonly assetName: string; readonly inventoryId: string }) => {
  const k = useK();
  const [title, setTitle] = useState(() => k('inventory.followUpDefault', { name: assetName }));
  const [dueDate, setDueDate] = useState(todayIsoDate);
  const [assignee, setAssignee] = useState('');
  const [error, setError] = useState<string | undefined>();
  const command = (): OpsCommand | undefined => {
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
    <PanelForm command={command} error={error} onSubmit={onSubmit} savableAtOnce value={{ assignee, dueDate, title }}>
      <ErrorLine message={error} />
      <TextField id="followup-title" label={k('fields.taskTitle')} onChange={setTitle} required value={title} />
      <FormGrid>
        <TextField
          id="followup-due"
          label={k('fields.dueDate')}
          onChange={setDueDate}
          required
          type="date"
          value={dueDate}
        />
        <TextField id="followup-assignee" label={k('fields.assignee')} onChange={setAssignee} value={assignee} />
      </FormGrid>
    </PanelForm>
  );
};

export const ArchiveForm = ({ asset, onSubmit }: FormProps & { readonly asset: Asset }) => {
  const k = useK();
  const [reason, setReason] = useState(() => k('archive.defaultReason'));
  const [error, setError] = useState<string | undefined>();
  const command = (): OpsCommand | undefined => {
    const trimmed = reason.trim();
    if (trimmed === '') {
      setError(k(formText.reasonRequired));
      return undefined;
    }
    setError(undefined);
    return { _tag: 'AssetArchive', assetId: asset.id, reason: trimmed };
  };
  return (
    <PanelForm command={command} error={error} onSubmit={onSubmit} savableAtOnce value={reason}>
      <ErrorLine message={error} />
      <TextField id="asset-archive-reason" label={k('archive.prompt')} onChange={setReason} required value={reason} />
    </PanelForm>
  );
};
