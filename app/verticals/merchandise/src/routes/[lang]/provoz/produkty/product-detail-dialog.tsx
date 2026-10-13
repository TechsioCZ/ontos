import { Button } from '@techsio/ui-kit/atoms/button';
import { NumericInput } from '@techsio/ui-kit/atoms/numeric-input';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormNumericInput } from '@techsio/ui-kit/molecules/form-numeric-input';
import { Switch } from '@techsio/ui-kit/molecules/switch';
import { Tabs } from '@techsio/ui-kit/molecules/tabs';
import { Table } from '@techsio/ui-kit/organisms/table';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { formatDate, formatMoney, SidePanel } from '@app/admin-ui';
import { DateTime } from 'effect';
import { useState } from 'react';
import type { ProductPatch } from '../../../../../shared/actions/apply-command.ts';
import type { ProductRecord, StockMovement } from '../../../../../shared/apis/records.ts';
import type { ProductUnit, VatRate } from '../../../../../shared/domain/merchandise-model.ts';
import { runCommand } from './products-api.ts';
import type { CommandOutcome, FailureReason } from './products-api.ts';
import {
  UNITS,
  VAT_RATES,
  fieldError,
  lowStockErrorKey,
  priceErrorKey,
  useCommandFailure,
  useProductLabel,
} from './product-forms.tsx';
import { MovementForm, MovementsTable } from './product-movements.tsx';

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
 * footer. The footer offers Zrušit and Uložit změny on the Detail tab only; the other tabs show Zavřít.
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

/** Editable product fields. Changed fields go to UpdateProduct; a changed price follows as ChangePrice. */
const DetailForm = ({
  canWrite,
  onCommitted,
  onOpenChange,
  onReload,
  product,
  revision,
  setBusy,
}: {
  readonly canWrite: boolean;
  readonly onCommitted: (message: string) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onReload: () => void;
  readonly product: ProductRecord;
  readonly revision: number;
  readonly setBusy: (busy: boolean) => void;
}) => {
  const k = useProductLabel();
  const failure = useCommandFailure();
  const [name, setName] = useState(product.name);
  const [category, setCategory] = useState(product.category);
  const [unit, setUnit] = useState<ProductUnit>(product.unit);
  const [vatRate, setVatRate] = useState<VatRate>(product.vatRate);
  const [lowStock, setLowStock] = useState(product.lowStockThreshold);
  const [priceCzk, setPriceCzk] = useState(product.currentPriceMinor / 100);
  const [active, setActive] = useState(product.active);
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const nameError = name.trim() === '' ? k('validation.required') : undefined;
  const categoryError = category.trim() === '' ? k('validation.required') : undefined;
  const priceKey = priceErrorKey(priceCzk);
  const priceError = priceKey === undefined ? undefined : k(priceKey);
  const lowStockKey = lowStockErrorKey(lowStock);
  const lowStockError = lowStockKey === undefined ? undefined : k(lowStockKey);

  const finish = (reason: FailureReason | null) => {
    setBusy(false);
    if (reason !== null) {
      setServerError(failure(reason, onReload));
      return;
    }
    onOpenChange(false);
    onCommitted(k('messages.updated'));
  };

  const save = () => {
    setSubmitted(true);
    if ([nameError, categoryError, priceError, lowStockError].some((message) => message !== undefined)) {
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
    const priceMinor = Math.round(priceCzk * 100);
    const priceChanged = priceMinor !== product.currentPriceMinor;
    if (!hasPatch && !priceChanged) {
      onOpenChange(false);
      return;
    }
    setBusy(true);
    setServerError(null);
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

  return (
    <form
      className="flex flex-col gap-200"
      id={DETAIL_FORM_ID}
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
          id="detail-price"
          label={k('fields.price')}
          locale="cs-CZ"
          min={0}
          name="price"
          onChange={setPriceCzk}
          step={1}
          value={priceCzk}
          {...fieldError(submitted, priceError)}
        >
          <NumericInput.Control>
            <NumericInput.Input />
          </NumericInput.Control>
        </FormNumericInput>
        <FormNumericInput
          disabled={!canWrite}
          id="detail-low-stock"
          label={k('fields.lowStock')}
          locale="cs-CZ"
          name="lowStock"
          onChange={setLowStock}
          step={1}
          value={lowStock}
          {...fieldError(submitted, lowStockError)}
        >
          <NumericInput.Control>
            <NumericInput.Input />
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
 * Product drawer. The parent remounts it (key = product id + updatedAt) after each save,
 * so the draft always starts from the stored values.
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
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('detail');
  const editing = canWrite && tab === 'detail';

  return (
    <SidePanel
      actions={
        <>
          <Button onClick={() => onOpenChange(false)} theme="outlined" variant="secondary">
            {k(editing ? 'common.cancel' : 'common.close')}
          </Button>
          {editing && (
            <Button
              form={DETAIL_FORM_ID}
              isLoading={busy}
              loadingText={k('common.save')}
              type="submit"
              variant="primary"
            >
              {k('common.save')}
            </Button>
          )}
        </>
      }
      description={`${product.sku} · ${formatMoney(product.currentPriceMinor)}`}
      onOpenChange={onOpenChange}
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
            canWrite={canWrite}
            onCommitted={onCommitted}
            onOpenChange={onOpenChange}
            onReload={onReload}
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
              onCommitted={onCommitted}
              onReload={onReload}
              productId={product.id}
              revision={revision}
              stockOnHand={product.stockOnHand}
            />
          )}
        </Tabs.Content>
      </Tabs>
    </SidePanel>
  );
};
