// Forms of the assets page. Each renders a <form id> whose submit button sits in the SidePanel footer and hands a
// typed command to `onSubmit`; the page runs it through the governed apply-command Action. Owned by ops-assets.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useState } from 'react';
import type { OpsCommand } from '../../../../../shared/agendas.ts';
import type {
  AcquisitionMethod,
  Asset,
  AssetKind,
  AssetsState,
  DepreciationInterval,
  DepreciationPlan,
  DepreciationType,
  DisposalKind,
  ServiceKind,
} from '../../../../../shared/domain/assets.ts';
import {
  acquisitionMethods,
  approvedTotal,
  assetKinds,
  disposalKinds,
  indicativeSchedule,
  isActiveAsset,
  manualEventKinds,
  serviceKinds,
} from '../../../../../shared/domain/assets.ts';
import type { PropertyRef } from '../../../../../shared/domain/common.ts';
import { money, parseCzk, todayIsoDate } from './assets-model.ts';
import {
  AreaField,
  CheckField,
  ErrorLine,
  FormGrid,
  PanelForm,
  SelectField,
  TextField,
  optional,
} from './form-kit.tsx';
import type { Option } from './form-kit.tsx';
import { locationItems, owningPropertyId, usePropertyTree } from './property-tree.ts';
import type { PropertyTree } from './property-tree.ts';
import { surfaceTileClassName } from '@app/admin-ui';

export interface FormProps {
  readonly formId: string;
  readonly onSubmit: (command: OpsCommand) => void;
}

const useK = () => {
  const { t } = useModernI18n();
  return (key: string, options?: Record<string, unknown>) => t(`facility-operations.assets.${key}`, options);
};

const NONE = 'none';

const locationOptions = (tree: PropertyTree, none: string): Option[] => [
  { label: none, value: NONE },
  ...locationItems(tree).map((item) => ({ label: item.label, value: item.value })),
];
const refOf = (tree: PropertyTree, value: string): PropertyRef | undefined =>
  locationItems(tree).find((item) => item.value === value)?.ref;

// ── Create / edit card ──────────────────────────────────────────────────────────────────────────────────

export const AssetCardForm = ({
  asset,
  formId,
  onSubmit,
  state,
}: FormProps & { readonly asset?: Asset; readonly state: AssetsState }) => {
  const k = useK();
  const tree = usePropertyTree();
  const [kind, setKind] = useState<AssetKind>(asset?.kind ?? 'equipment');
  const [inventoryNumber, setInventoryNumber] = useState(asset?.inventoryNumber ?? '');
  const [name, setName] = useState(asset?.name ?? '');
  const [category, setCategory] = useState(asset?.category ?? '');
  const [location, setLocation] = useState(
    asset?.location === undefined ? NONE : `${asset.location.kind}:${asset.location.id}`,
  );
  const [responsible, setResponsible] = useState(asset?.responsible ?? '');
  const [serialNumber, setSerialNumber] = useState(asset?.serialNumber ?? '');
  const [accountingProduct, setAccountingProduct] = useState(asset?.accountingProduct ?? '');
  const [note, setNote] = useState(asset?.note ?? '');
  const [acquisitionDate, setAcquisitionDate] = useState('');
  const [acquisitionMethod, setAcquisitionMethod] = useState<AcquisitionMethod>('purchase');
  const [acquisitionValue, setAcquisitionValue] = useState('');
  const [placedInServiceDate, setPlacedInServiceDate] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);

  const submit = () => {
    if (inventoryNumber.trim() === '' || name.trim() === '' || category.trim() === '') {
      setError(k('form.required'));
      return;
    }
    if (
      asset === undefined &&
      state.assets.some((entry) => entry.inventoryNumber.toLowerCase() === inventoryNumber.trim().toLowerCase())
    ) {
      setError(k('form.duplicateNumber'));
      return;
    }
    const value = parseCzk(acquisitionValue);
    if (value === null) {
      setError(k('form.invalidAmount'));
      return;
    }
    setError(undefined);
    const picked = location === NONE ? undefined : (refOf(tree, location) ?? asset?.location);
    const propertyId = owningPropertyId(tree, picked) ?? (picked === asset?.location ? asset?.propertyId : undefined);
    const card = {
      category: category.trim(),
      kind,
      name: name.trim(),
      ...optional('responsible', responsible),
      ...optional('serialNumber', serialNumber),
      ...optional('accountingProduct', accountingProduct),
      ...optional('note', note),
      ...(picked === undefined ? {} : { location: picked }),
      ...(propertyId === undefined ? {} : { propertyId }),
    };
    if (asset === undefined) {
      onSubmit({
        _tag: 'AssetCreate',
        ...card,
        acquisitionMethod,
        inventoryNumber: inventoryNumber.trim(),
        ...optional('acquisitionDate', acquisitionDate),
        ...optional('placedInServiceDate', placedInServiceDate),
        ...(value === undefined ? {} : { acquisitionValueMinor: value }),
      });
    } else {
      onSubmit({ _tag: 'AssetUpdate', assetId: asset.id, ...card });
    }
  };

  return (
    <PanelForm id={formId} onSubmit={submit}>
      <ErrorLine message={error} />
      <FormGrid>
        <TextField
          id="asset-inventory-number"
          label={k('fields.inventoryNumber')}
          maxLength={64}
          onChange={setInventoryNumber}
          required
          value={inventoryNumber}
          {...(asset === undefined ? {} : { helpText: k('form.numberFixed') })}
        />
        <SelectField
          label={k('fields.kind')}
          name="kind"
          onChange={(value) => setKind(assetKinds.find((entry) => entry === value) ?? 'equipment')}
          options={assetKinds.map((entry) => ({ label: k(`kind.${entry}`), value: entry }))}
          value={kind}
        />
      </FormGrid>
      <TextField id="asset-name" label={k('fields.name')} onChange={setName} required value={name} />
      <FormGrid>
        <TextField
          id="asset-category"
          label={k('fields.category')}
          maxLength={120}
          onChange={setCategory}
          placeholder={k('form.categoryPlaceholder')}
          required
          value={category}
        />
        <TextField
          id="asset-serial"
          label={k('fields.serialNumber')}
          maxLength={120}
          onChange={setSerialNumber}
          value={serialNumber}
        />
      </FormGrid>
      <SelectField
        label={k('fields.location')}
        name="location"
        onChange={(value) => setLocation(value === '' ? NONE : value)}
        options={locationOptions(tree, k('form.noLocation'))}
        value={location}
      />
      {tree.status === 'failed' && <ErrorLine message={k('form.propertiesFailed')} />}
      <TextField id="asset-responsible" label={k('fields.responsible')} onChange={setResponsible} value={responsible} />
      {asset === undefined && (
        <>
          <FormGrid>
            <TextField
              id="asset-acquisition-date"
              label={k('fields.acquisitionDate')}
              onChange={setAcquisitionDate}
              type="date"
              value={acquisitionDate}
            />
            <SelectField
              label={k('fields.acquisitionMethod')}
              name="acquisitionMethod"
              onChange={(value) =>
                setAcquisitionMethod(acquisitionMethods.find((entry) => entry === value) ?? 'purchase')
              }
              options={acquisitionMethods.map((entry) => ({ label: k(`method.${entry}`), value: entry }))}
              value={acquisitionMethod}
            />
          </FormGrid>
          <FormGrid>
            <TextField
              helpText={k('form.amountHelp')}
              id="asset-acquisition-value"
              inputMode="decimal"
              label={k('fields.acquisitionValue')}
              onChange={setAcquisitionValue}
              value={acquisitionValue}
            />
            <TextField
              id="asset-in-service"
              label={k('fields.placedInService')}
              onChange={setPlacedInServiceDate}
              type="date"
              value={placedInServiceDate}
            />
          </FormGrid>
        </>
      )}
      <TextField
        helpText={k('form.accountingProductHelp')}
        id="asset-accounting-product"
        label={k('fields.accountingProduct')}
        onChange={setAccountingProduct}
        value={accountingProduct}
      />
      <AreaField id="asset-note" label={k('fields.note')} onChange={setNote} value={note} />
    </PanelForm>
  );
};

// ── Value change (S02-02) ─────────────────────────────────────────────────────────────────────────────

export const ValueChangeForm = ({ asset, formId, onSubmit }: FormProps & { readonly asset: Asset }) => {
  const k = useK();
  const [value, setValue] = useState('');
  const [date, setDate] = useState(todayIsoDate());
  const [reason, setReason] = useState('');
  const [documentRef, setDocumentRef] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const submit = () => {
    const parsed = parseCzk(value);
    if (parsed === undefined || parsed === null) {
      setError(k('form.invalidAmount'));
      return;
    }
    if (reason.trim() === '' || date === '') {
      setError(k('form.reasonRequired'));
      return;
    }
    setError(undefined);
    onSubmit({
      _tag: 'AssetValueChange',
      assetId: asset.id,
      date,
      newValueMinor: parsed,
      reason: reason.trim(),
      ...optional('documentRef', documentRef),
    });
  };
  return (
    <PanelForm id={formId} onSubmit={submit}>
      <p className="text-fg-secondary text-sm">
        {k('form.valueIntro', { value: money(asset.currentValueMinor, k('notProvided')) })}
      </p>
      <ErrorLine message={error} />
      <FormGrid>
        <TextField
          helpText={k('form.amountHelp')}
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
        helpText={k('form.documentHelp')}
        id="value-document"
        label={k('fields.documentRef')}
        onChange={setDocumentRef}
        value={documentRef}
      />
    </PanelForm>
  );
};

// ── Timeline event ────────────────────────────────────────────────────────────────────────────────────

export const EventForm = ({ asset, formId, onSubmit }: FormProps & { readonly asset: Asset }) => {
  const k = useK();
  const [kind, setKind] = useState<(typeof manualEventKinds)[number]>('construction');
  const [date, setDate] = useState(todayIsoDate());
  const [note, setNote] = useState('');
  const [documentRef, setDocumentRef] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const submit = () => {
    if (note.trim() === '' || date === '') {
      setError(k('form.required'));
      return;
    }
    setError(undefined);
    onSubmit({
      _tag: 'AssetEventRecord',
      assetId: asset.id,
      date,
      kind,
      note: note.trim(),
      ...optional('documentRef', documentRef),
    });
  };
  return (
    <PanelForm id={formId} onSubmit={submit}>
      <ErrorLine message={error} />
      <FormGrid>
        <SelectField
          label={k('fields.eventKind')}
          name="eventKind"
          onChange={(value) => setKind(manualEventKinds.find((entry) => entry === value) ?? 'note')}
          options={manualEventKinds.map((entry) => ({ label: k(`event.${entry}`), value: entry }))}
          value={kind}
        />
        <TextField id="event-date" label={k('fields.date')} onChange={setDate} required type="date" value={date} />
      </FormGrid>
      <AreaField id="event-note" label={k('fields.description')} onChange={setNote} required value={note} />
      <TextField
        helpText={k('form.documentHelp')}
        id="event-document"
        label={k('fields.documentRef')}
        onChange={setDocumentRef}
        value={documentRef}
      />
    </PanelForm>
  );
};

// ── Disposal (S02-04) ─────────────────────────────────────────────────────────────────────────────────

export const DisposeForm = ({ asset, formId, onSubmit }: FormProps & { readonly asset: Asset }) => {
  const k = useK();
  const [kind, setKind] = useState<DisposalKind>('retirement');
  const [date, setDate] = useState(todayIsoDate());
  const [reason, setReason] = useState('');
  const [proceeds, setProceeds] = useState('');
  const [documentRef, setDocumentRef] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const submit = () => {
    const parsed = parseCzk(proceeds);
    if (parsed === null) {
      setError(k('form.invalidAmount'));
      return;
    }
    if (reason.trim() === '' || date === '') {
      setError(k('form.reasonRequired'));
      return;
    }
    setError(undefined);
    onSubmit({
      _tag: 'AssetDispose',
      assetId: asset.id,
      date,
      kind,
      reason: reason.trim(),
      ...optional('documentRef', documentRef),
      ...(parsed === undefined || kind !== 'sale' ? {} : { proceedsMinor: parsed }),
    });
  };
  return (
    <PanelForm id={formId} onSubmit={submit}>
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
        <TextField id="dispose-date" label={k('fields.date')} onChange={setDate} required type="date" value={date} />
      </FormGrid>
      <AreaField id="dispose-reason" label={k('fields.reason')} onChange={setReason} required value={reason} />
      {kind === 'sale' && (
        <TextField
          helpText={k('form.amountHelp')}
          id="dispose-proceeds"
          inputMode="decimal"
          label={k('fields.proceeds')}
          onChange={setProceeds}
          value={proceeds}
        />
      )}
      <TextField
        helpText={k('form.documentHelp')}
        id="dispose-document"
        label={k('fields.documentRef')}
        onChange={setDocumentRef}
        value={documentRef}
      />
    </PanelForm>
  );
};

// ── Revision / service / permit ───────────────────────────────────────────────────────────────────────

export const ServiceForm = ({ asset, formId, onSubmit }: FormProps & { readonly asset: Asset }) => {
  const k = useK();
  const [kind, setKind] = useState<ServiceKind>('revision');
  const [title, setTitle] = useState('');
  const [performedOn, setPerformedOn] = useState(todayIsoDate());
  const [nextDueOn, setNextDueOn] = useState('');
  const [supplier, setSupplier] = useState('');
  const [responsible, setResponsible] = useState(asset.responsible ?? '');
  const [result, setResult] = useState('ok');
  const [permitState, setPermitState] = useState('requested');
  const [documentRef, setDocumentRef] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const submit = () => {
    if (title.trim() === '') {
      setError(k('form.required'));
      return;
    }
    if (kind !== 'permit' && performedOn === '' && nextDueOn === '') {
      setError(k('form.serviceDates'));
      return;
    }
    setError(undefined);
    onSubmit({
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
      ...(kind === 'permit'
        ? {
            permitState:
              permitState === 'granted'
                ? 'granted'
                : permitState === 'in_progress'
                  ? 'in_progress'
                  : permitState === 'rejected'
                    ? 'rejected'
                    : permitState === 'expired'
                      ? 'expired'
                      : 'requested',
          }
        : performedOn === ''
          ? {}
          : { result: result === 'defects' ? 'defects' : result === 'failed' ? 'failed' : 'ok' }),
    });
  };
  return (
    <PanelForm id={formId} onSubmit={submit}>
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
            onChange={setPermitState}
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
            onChange={setResult}
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
        helpText={k('form.documentHelp')}
        id="service-document"
        label={k('fields.documentRef')}
        onChange={setDocumentRef}
        value={documentRef}
      />
      <AreaField id="service-note" label={k('fields.note')} onChange={setNote} value={note} />
    </PanelForm>
  );
};

// ── Depreciation plan (S03) ───────────────────────────────────────────────────────────────────────────

export const PlanForm = ({
  asset,
  formId,
  onSubmit,
  state,
  type,
}: FormProps & { readonly asset: Asset; readonly state: AssetsState; readonly type: DepreciationType }) => {
  const k = useK();
  const templates = (state.templates ?? []).filter((template) => template.type === type);
  const [templateId, setTemplateId] = useState(NONE);
  const [method, setMethod] = useState('Rovnoměrný');
  const [years, setYears] = useState('');
  const [interval, setPlanInterval] = useState<DepreciationInterval>('yearly');
  const [taxGroup, setTaxGroup] = useState('');
  const [base, setBase] = useState(
    asset.acquisitionValueMinor === undefined ? '' : String(asset.acquisitionValueMinor / 100),
  );
  const [startDate, setStartDate] = useState(asset.placedInServiceDate ?? asset.acquisitionDate ?? todayIsoDate());
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
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
  const submit = () => {
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
      return;
    }
    if (method.trim() === '' || startDate === '') {
      setError(k('form.required'));
      return;
    }
    setError(undefined);
    onSubmit({
      _tag: 'AssetDepreciationPlanCreate',
      assetId: asset.id,
      baseMinor: parsedBase,
      interval,
      method: method.trim(),
      startDate,
      type,
      years: parsedYears,
      ...optional('taxGroup', type === 'tax' ? taxGroup : ''),
      ...optional('note', note),
      ...(templateId === NONE ? {} : { templateId }),
    });
  };
  return (
    <PanelForm id={formId} onSubmit={submit}>
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
          helpText={k('form.amountHelp')}
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
          value={interval}
        />
      </FormGrid>
      <AreaField id="plan-note" label={k('fields.note')} onChange={setNote} value={note} />
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
  formId,
  onSubmit,
  plan,
}: FormProps & { readonly asset: Asset; readonly plan: DepreciationPlan }) => {
  const k = useK();
  const [period, setPeriod] = useState(nextOpenPeriod(plan));
  const [amount, setAmount] = useState('');
  const [documentRef, setDocumentRef] = useState('');
  const [partial, setPartial] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const remaining = plan.baseMinor - approvedTotal(plan);
  const submit = () => {
    const parsed = parseCzk(amount);
    const periodPattern = plan.interval === 'monthly' ? /^\d{4}-(0[1-9]|1[0-2])$/ : /^\d{4}$/;
    if (!periodPattern.test(period.trim())) {
      setError(k(plan.interval === 'monthly' ? 'form.periodMonthly' : 'form.periodYearly'));
      return;
    }
    if (parsed === undefined || parsed === null) {
      setError(k('form.invalidAmount'));
      return;
    }
    if (parsed > remaining) {
      setError(k('form.overBase', { remaining: money(remaining, '—') }));
      return;
    }
    if (plan.entries.some((entry) => entry.period === period.trim())) {
      setError(k('form.periodTaken'));
      return;
    }
    setError(undefined);
    onSubmit({
      _tag: 'AssetDepreciationEntryRecord',
      amountMinor: parsed,
      assetId: asset.id,
      period: period.trim(),
      planId: plan.id,
      ...optional('documentRef', documentRef),
      ...optional('note', note),
      ...(partial ? { partial: true } : {}),
    });
  };
  return (
    <PanelForm id={formId} onSubmit={submit}>
      <p className="text-fg-secondary text-sm">
        {k('form.entryIntro', { type: k(`depreciation.${plan.type}`), remaining: money(remaining, '—') })}
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
          helpText={k('form.amountHelp')}
          id="entry-amount"
          inputMode="decimal"
          label={k('fields.approvedAmount')}
          onChange={setAmount}
          required
          value={amount}
        />
      </FormGrid>
      <TextField
        helpText={k('form.documentHelp')}
        id="entry-document"
        label={k('fields.documentRef')}
        onChange={setDocumentRef}
        value={documentRef}
      />
      <CheckField checked={partial} id="entry-partial" label={k('fields.partial')} onChange={setPartial} />
      <AreaField id="entry-note" label={k('fields.note')} onChange={setNote} value={note} />
    </PanelForm>
  );
};

export const TemplateForm = ({ formId, onSubmit }: FormProps) => {
  const k = useK();
  const [name, setName] = useState('');
  const [type, setType] = useState<DepreciationType>('accounting');
  const [method, setMethod] = useState('Rovnoměrný');
  const [years, setYears] = useState('');
  const [interval, setPlanInterval] = useState<DepreciationInterval>('yearly');
  const [taxGroup, setTaxGroup] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const submit = () => {
    const parsedYears = Number(years);
    if (
      name.trim() === '' ||
      method.trim() === '' ||
      !Number.isInteger(parsedYears) ||
      parsedYears < 1 ||
      parsedYears > 100
    ) {
      setError(k('form.planInvalid'));
      return;
    }
    setError(undefined);
    onSubmit({
      _tag: 'AssetDepreciationTemplateCreate',
      interval,
      method: method.trim(),
      name: name.trim(),
      type,
      years: parsedYears,
      ...optional('taxGroup', type === 'tax' ? taxGroup : ''),
      ...optional('note', note),
    });
  };
  return (
    <PanelForm id={formId} onSubmit={submit}>
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
          value={interval}
        />
      </FormGrid>
      {type === 'tax' && (
        <TextField id="template-tax-group" label={k('fields.taxGroup')} onChange={setTaxGroup} value={taxGroup} />
      )}
      <AreaField id="template-note" label={k('fields.note')} onChange={setNote} value={note} />
    </PanelForm>
  );
};

// ── Inventory (S02 inventura) ─────────────────────────────────────────────────────────────────────────

export const InventoryCreateForm = ({ formId, onSubmit, state }: FormProps & { readonly state: AssetsState }) => {
  const k = useK();
  const tree = usePropertyTree();
  const [scope, setScope] = useState('');
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(todayIsoDate());
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const properties = tree.status === 'ready' ? tree.nodes : [];
  const picked = properties.find((node) => node.ref.id === scope);
  const candidates = state.assets.filter(
    (asset) => isActiveAsset(asset) && (scope === '' || asset.propertyId === scope || asset.location?.id === scope),
  );
  const submit = () => {
    if (title.trim() === '' || date === '') {
      setError(k('form.required'));
      return;
    }
    if (candidates.length === 0) {
      setError(k('inventory.noCandidates'));
      return;
    }
    setError(undefined);
    onSubmit({
      _tag: 'AssetInventoryCreate',
      assetIds: candidates.map((asset) => asset.id),
      date,
      title: title.trim(),
      ...optional('note', note),
      ...(picked === undefined ? {} : { scope: picked.ref }),
    });
  };
  return (
    <PanelForm id={formId} onSubmit={submit}>
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
              `${k('inventory.defaultTitlePrefix')} ${date.slice(0, 4)} – ${node?.ref.label.replace(/ \([^)]*\)$/, '') ?? k('inventory.wholeCompany')}`,
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
        <TextField id="inventory-date" label={k('fields.date')} onChange={setDate} required type="date" value={date} />
      </FormGrid>
      <AreaField id="inventory-note" label={k('fields.note')} onChange={setNote} value={note} />
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
  assetName,
  formId,
  onSubmit,
  assetId,
  inventoryId,
}: FormProps & { readonly assetId: Asset['id']; readonly assetName: string; readonly inventoryId: string }) => {
  const k = useK();
  const [title, setTitle] = useState(k('inventory.followUpDefault', { name: assetName }));
  const [dueDate, setDueDate] = useState(todayIsoDate());
  const [assignee, setAssignee] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const submit = () => {
    if (title.trim() === '' || dueDate === '') {
      setError(k('form.required'));
      return;
    }
    setError(undefined);
    onSubmit({
      _tag: 'AssetInventoryFollowUp',
      assetId,
      dueDate,
      inventoryId,
      title: title.trim(),
      ...optional('assignee', assignee),
    });
  };
  return (
    <PanelForm id={formId} onSubmit={submit}>
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
