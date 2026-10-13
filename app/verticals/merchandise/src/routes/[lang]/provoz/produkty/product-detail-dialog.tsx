import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { NumericInput } from '@techsio/ui-kit/atoms/numeric-input';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormNumericInput } from '@techsio/ui-kit/molecules/form-numeric-input';
import { Switch } from '@techsio/ui-kit/molecules/switch';
import { Tabs } from '@techsio/ui-kit/molecules/tabs';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { Table } from '@techsio/ui-kit/organisms/table';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { dialogCloseLabel, formatDate, formatMoney, SidePanel } from '@app/admin-ui';
import { DateTime } from 'effect';
import { useEffect, useRef, useState } from 'react';
import type { ProductPatch } from '../../../../../shared/actions/apply-command.ts';
import type { ProductRecord, StockMovement } from '../../../../../shared/apis/records.ts';
import type { ProductUnit, VatRate } from '../../../../../shared/domain/merchandise-model.ts';
import { MONEY_FORMAT, NO_ARIA_MAX, WHOLE_NUMBER_FORMAT, moneyInputText } from '../../../../form-number.ts';
import { runCommand } from './products-api.ts';
import type { CommandOutcome, FailureReason } from './products-api.ts';
import {
  PRODUCT_LIMITS,
  UNITS,
  VAT_RATES,
  fieldError,
  focusFirstInvalid,
  lowStockErrorKey,
  priceErrorKey,
  tooLongMessage,
  useCommandFailure,
  useProductLabel,
} from './product-forms.tsx';
import { EMPTY_MOVEMENT_DRAFT, MovementForm, MovementsTable, isMovementDraftDirty } from './product-movements.tsx';
import type { MovementDraft } from './product-movements.tsx';

export interface ProductDetailDialogProps {
  readonly canWrite: boolean;
  readonly movements: readonly StockMovement[];
  readonly onCommitted: (message: string) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onReload: () => void;
  readonly open: boolean;
  readonly product: ProductRecord;
  readonly revision: number;
}

/** Writable subset of ProductPatch, filled field by field so only changed values are sent. */
type PatchDraft = { -readonly [Key in keyof ProductPatch]?: ProductPatch[Key] };

/**
 * The panel footer submits the detail form through this id, so the save button stays in the fixed
 * footer. The footer shows only on the Detail tab, where the form lives. Tab contents stay mounted, so the
 * draft survives a tab switch.
 */
const DETAIL_FORM_ID = 'product-detail-form';

const PriceHistory = ({ product }: { readonly product: ProductRecord }) => {
  const k = useProductLabel();
  const rows = product.priceHistory.toSorted(
    (left, right) => DateTime.toEpochMillis(right.effectiveFrom) - DateTime.toEpochMillis(left.effectiveFrom),
  );

  if (rows.length === 0) {
    return <p className="text-fg-secondary text-sm">{k('prices.empty')}</p>;
  }
  return (
    <Table size="sm" variant="line">
      <Table.Header>
        <Table.Row>
          <Table.ColumnHeader align="end">{k('prices.columnPrice')}</Table.ColumnHeader>
          <Table.ColumnHeader>{k('prices.columnValidFrom')}</Table.ColumnHeader>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {rows.map((entry) => (
          <Table.Row key={DateTime.toEpochMillis(entry.effectiveFrom)}>
            <Table.Cell align="end" className="tabular-nums">
              {formatMoney(entry.priceMinor)}
            </Table.Cell>
            <Table.Cell>{formatDate(DateTime.formatIso(entry.effectiveFrom))}</Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  );
};

/** Editable product fields as typed. The panel owns the draft, so Esc and outside clicks can see unsaved edits. */
interface DetailDraft {
  readonly active: boolean;
  readonly category: string;
  readonly lowStock: number;
  /** The minimum-stock input's text, kept as typed so "2,5" reaches validation instead of becoming 25. */
  readonly lowStockText: string;
  readonly name: string;
  readonly priceCzk: number;
  /** The price input's text, kept as typed so the two-decimal display never fights the keyboard. */
  readonly priceText: string;
  readonly unit: ProductUnit;
  readonly vatRate: VatRate;
}

const draftOf = (product: ProductRecord): DetailDraft => ({
  active: product.active,
  category: product.category,
  lowStock: product.lowStockThreshold,
  lowStockText: String(product.lowStockThreshold),
  name: product.name,
  priceCzk: product.currentPriceMinor / 100,
  priceText: moneyInputText(product.currentPriceMinor / 100),
  unit: product.unit,
  vatRate: product.vatRate,
});

/** True when Save would send something: a changed field or a changed price. */
const isDraftDirty = (draft: DetailDraft, product: ProductRecord): boolean =>
  draft.name.trim() !== product.name ||
  draft.category.trim() !== product.category ||
  draft.unit !== product.unit ||
  draft.vatRate !== product.vatRate ||
  draft.lowStock !== product.lowStockThreshold ||
  Math.round(draft.priceCzk * 100) !== product.currentPriceMinor ||
  draft.active !== product.active;

/**
 * Editable product fields. Changed fields go to UpdateProduct; a changed price follows as ChangePrice. The two
 * commands run one after the other and can take a few seconds, so a persistent "Ukládám změny…" toast shows
 * from the first click until the outcome replaces it.
 */
const DetailForm = ({
  busy,
  canWrite,
  draft,
  onClose,
  onCommitted,
  onDraftChange,
  onReload,
  onSaved,
  product,
  revision,
  setBusy,
}: {
  readonly busy: boolean;
  readonly canWrite: boolean;
  readonly draft: DetailDraft;
  /** Close without saving: asks first when another tab still holds an unsent draft. */
  readonly onClose: () => void;
  readonly onCommitted: (message: string) => void;
  readonly onDraftChange: (patch: Partial<DetailDraft>) => void;
  readonly onReload: () => void;
  /** Called after a successful save; the panel decides whether it can close. */
  readonly onSaved: () => void;
  readonly product: ProductRecord;
  readonly revision: number;
  readonly setBusy: (busy: boolean) => void;
}) => {
  const k = useProductLabel();
  const failure = useCommandFailure();
  const toaster = useToast();
  const { active, category, lowStock, lowStockText, name, priceCzk, priceText, unit, vatRate } = draft;
  const setActive = (value: boolean) => {
    onDraftChange({ active: value });
  };
  const setCategory = (value: string) => {
    onDraftChange({ category: value });
  };
  const setName = (value: string) => {
    onDraftChange({ name: value });
  };
  const setUnit = (value: ProductUnit) => {
    onDraftChange({ unit: value });
  };
  const setVatRate = (value: VatRate) => {
    onDraftChange({ vatRate: value });
  };
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const nameError = name.trim() === '' ? k('validation.required') : tooLongMessage(k, name, PRODUCT_LIMITS.name);
  const categoryError =
    category.trim() === '' ? k('validation.required') : tooLongMessage(k, category, PRODUCT_LIMITS.category);
  const priceKey = priceErrorKey(priceCzk);
  const priceError = priceKey === undefined ? undefined : k(priceKey);
  const lowStockKey = lowStockErrorKey(lowStock);
  const lowStockError = lowStockKey === undefined ? undefined : k(lowStockKey);
  const priceMinor = Math.round(priceCzk * 100);

  const save = () => {
    if (busy) {
      return;
    }
    setSubmitted(true);
    if ([nameError, categoryError, priceError, lowStockError].some((message) => message !== undefined)) {
      focusFirstInvalid([
        ['detail-name', nameError !== undefined],
        ['detail-category', categoryError !== undefined],
        ['detail-price', priceError !== undefined],
        ['detail-low-stock', lowStockError !== undefined],
      ]);
      return;
    }
    const patch: PatchDraft = {};
    if (name.trim() !== product.name) {
      patch.name = name.trim();
    }
    if (category.trim() !== product.category) {
      patch.category = category.trim();
    }
    if (unit !== product.unit) {
      patch.unit = unit;
    }
    if (vatRate !== product.vatRate) {
      patch.vatRate = vatRate;
    }
    if (lowStock !== product.lowStockThreshold) {
      patch.lowStockThreshold = lowStock;
    }
    if (active !== product.active) {
      patch.active = active;
    }
    const hasPatch = Object.keys(patch).length > 0;
    const priceChanged = priceMinor !== product.currentPriceMinor;
    if (!hasPatch && !priceChanged) {
      onClose();
      return;
    }
    setBusy(true);
    setServerError(null);
    const savingToast = toaster.create({
      duration: Number.POSITIVE_INFINITY,
      title: k('messages.saving'),
      type: 'info',
    });
    const finish = (reason: FailureReason | null) => {
      setBusy(false);
      toaster.dismiss(savingToast);
      if (reason !== null) {
        setServerError(failure(reason, onReload));
        return;
      }
      onSaved();
      onCommitted(k('messages.updated'));
    };
    const afterPatch = (outcome: CommandOutcome) => {
      if (!outcome.ok) {
        finish(outcome.reason);
        return;
      }
      if (!priceChanged) {
        finish(null);
        return;
      }
      runCommand({ _tag: 'ChangePrice', id: product.id, priceMinor }, outcome.revision, (second) =>
        finish(second.ok ? null : second.reason),
      );
    };
    if (hasPatch) {
      runCommand({ _tag: 'UpdateProduct', id: product.id, patch }, revision, afterPatch);
    } else {
      afterPatch({ ok: true, revision });
    }
  };

  // noValidate: the form may sit in a hidden tab when the footer submits it, and native validation would
  // block that silently; save() validates and shows the Czech messages instead.
  return (
    <form
      className="flex flex-col gap-200"
      id={DETAIL_FORM_ID}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      {serverError !== null && (
        <StatusText showIcon status="error">
          {serverError}
        </StatusText>
      )}
      <FormInput disabled id="detail-sku" label={k('fields.sku')} name="sku" value={product.sku} />
      <FormInput
        autoComplete="off"
        disabled={!canWrite}
        id="detail-name"
        label={k('fields.name')}
        name="name"
        onChange={(event) => setName(event.target.value)}
        required
        value={name}
        {...fieldError(submitted, nameError)}
      />
      <FormInput
        autoComplete="off"
        disabled={!canWrite}
        id="detail-category"
        label={k('fields.category')}
        name="category"
        onChange={(event) => setCategory(event.target.value)}
        required
        value={category}
        {...fieldError(submitted, categoryError)}
      />
      <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
        <SelectTemplate
          disabled={!canWrite}
          items={UNITS.map((value) => ({ label: value, value }))}
          label={k('fields.unit')}
          name="unit"
          onValueChange={(details) => {
            const [next] = details.value;
            const picked = UNITS.find((value) => value === next);
            if (picked !== undefined) {
              setUnit(picked);
            }
          }}
          placeholder={k('selectPlaceholder')}
          value={[unit]}
        />
        <SelectTemplate
          disabled={!canWrite}
          items={VAT_RATES.map((rate) => ({ label: `${rate} %`, value: String(rate) }))}
          label={k('fields.vat')}
          name="vat"
          onValueChange={(details) => {
            const [next] = details.value;
            const picked = VAT_RATES.find((rate) => String(rate) === next);
            if (picked !== undefined) {
              setVatRate(picked);
            }
          }}
          placeholder={k('selectPlaceholder')}
          value={[String(vatRate)]}
        />
      </div>
      <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
        <FormNumericInput
          disabled={!canWrite}
          formatOptions={MONEY_FORMAT}
          id="detail-price"
          label={k('fields.price')}
          locale="cs-CZ"
          min={0}
          name="price"
          onValueChange={(details) => {
            onDraftChange({ priceCzk: details.valueAsNumber, priceText: details.value });
          }}
          required
          step={1}
          value={priceText}
          {...fieldError(submitted, priceError)}
        >
          <NumericInput.Control>
            <NumericInput.Input {...NO_ARIA_MAX} />
          </NumericInput.Control>
        </FormNumericInput>
        <FormNumericInput
          clampValueOnBlur={false}
          disabled={!canWrite}
          formatOptions={WHOLE_NUMBER_FORMAT}
          id="detail-low-stock"
          label={k('fields.lowStock')}
          locale="cs-CZ"
          min={0}
          name="lowStock"
          onValueChange={(details) => {
            onDraftChange({ lowStock: details.valueAsNumber, lowStockText: details.value });
          }}
          step={1}
          value={lowStockText}
          {...fieldError(submitted, lowStockError)}
        >
          <NumericInput.Control>
            <NumericInput.Input {...NO_ARIA_MAX} />
          </NumericInput.Control>
        </FormNumericInput>
      </div>
      <Switch checked={active} disabled={!canWrite} name="active" onCheckedChange={setActive}>
        {k('detail.active')}
      </Switch>
    </form>
  );
};

/**
 * Product drawer. The parent keys it by product id only, so a stock movement or a conflict reload keeps the
 * open tab and the unsaved draft; a save closes the drawer, and the next open starts from the stored values.
 */
export const ProductDetailDialog = ({
  canWrite,
  movements,
  onCommitted,
  onOpenChange,
  onReload,
  open,
  product,
  revision,
}: ProductDetailDialogProps) => {
  const k = useProductLabel();
  const { t } = useModernI18n();
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(() => draftOf(product));
  const [discardOpen, setDiscardOpen] = useState(false);
  const [movementDraft, setMovementDraft] = useState(EMPTY_MOVEMENT_DRAFT);
  // A detail save finishes seconds after the click; it reads the movement draft as it is then, not at the click.
  const movementDraftRef = useRef(movementDraft);
  useEffect(() => {
    movementDraftRef.current = movementDraft;
  }, [movementDraft]);
  const [tab, setTab] = useState('detail');
  const dirty = isDraftDirty(draft, product) || isMovementDraftDirty(movementDraft);
  const updateDraft = (patch: Partial<DetailDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
  };
  const updateMovementDraft = (patch: Partial<MovementDraft>) => {
    setMovementDraft((current) => ({ ...current, ...patch }));
  };

  // A draft with unsaved edits is never dropped silently: Esc, the close button and Zrušit ask first.
  const requestClose = (next: boolean) => {
    if (next) {
      return;
    }
    if (dirty) {
      setDiscardOpen(true);
      return;
    }
    onOpenChange(false);
  };

  // After a detail save, an unsent movement keeps the panel open on Pohyby instead of being dropped.
  const closeAfterSave = () => {
    if (isMovementDraftDirty(movementDraftRef.current)) {
      setTab('movements');
      return;
    }
    onOpenChange(false);
  };

  return (
    <>
      <SidePanel
        actions={
          tab === 'detail' ? (
            <>
              <Button onClick={() => requestClose(false)} theme="outlined" variant="secondary">
                {k('common.cancel')}
              </Button>
              {canWrite && (
                <Button
                  form={DETAIL_FORM_ID}
                  isLoading={busy}
                  loadingText={k('messages.saving')}
                  type="submit"
                  variant="primary"
                >
                  {k('common.save')}
                </Button>
              )}
            </>
          ) : undefined
        }
        closeOnInteractOutside={!dirty}
        description={`${product.sku} · ${formatMoney(product.currentPriceMinor)}`}
        onOpenChange={requestClose}
        open={open}
        size="md"
        title={product.name}
      >
        <Tabs onValueChange={setTab} value={tab} variant="line">
          <Tabs.List>
            <Tabs.Trigger value="detail">{k('detail.tab')}</Tabs.Trigger>
            <Tabs.Trigger value="prices">{k('prices.tab')}</Tabs.Trigger>
            <Tabs.Trigger value="movements">{k('movements.tab')}</Tabs.Trigger>
            <Tabs.Indicator />
          </Tabs.List>
          <Tabs.Content className="py-200" value="detail">
            <DetailForm
              busy={busy}
              canWrite={canWrite}
              draft={draft}
              onClose={() => requestClose(false)}
              onCommitted={onCommitted}
              onDraftChange={updateDraft}
              onReload={onReload}
              onSaved={closeAfterSave}
              product={product}
              revision={revision}
              setBusy={setBusy}
            />
          </Tabs.Content>
          <Tabs.Content className="py-200" value="prices">
            <PriceHistory product={product} />
          </Tabs.Content>
          <Tabs.Content className="flex flex-col gap-200 py-200" value="movements">
            <MovementsTable movements={movements} />
            {canWrite && (
              <MovementForm
                draft={movementDraft}
                onCommitted={onCommitted}
                onDraftChange={updateMovementDraft}
                onReload={onReload}
                productId={product.id}
                revision={revision}
                stockOnHand={product.stockOnHand}
              />
            )}
          </Tabs.Content>
        </Tabs>
      </SidePanel>
      <Dialog
        actions={
          <>
            <Button onClick={() => setDiscardOpen(false)} theme="outlined" variant="secondary">
              {k('detail.discardKeep')}
            </Button>
            <Button
              onClick={() => {
                setDiscardOpen(false);
                onOpenChange(false);
              }}
              variant="danger"
            >
              {k('detail.discardAction')}
            </Button>
          </>
        }
        closeLabel={dialogCloseLabel}
        customTrigger
        description={k('detail.discardDescription')}
        onOpenChange={({ open: next }) => {
          if (!next) {
            setDiscardOpen(false);
          }
        }}
        open={discardOpen}
        role="alertdialog"
        size="sm"
        title={t('merchandise.pages.products.detail.discardTitle', { name: product.name })}
      />
    </>
  );
};
