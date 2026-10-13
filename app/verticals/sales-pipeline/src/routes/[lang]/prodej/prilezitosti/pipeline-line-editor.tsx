import { formatMoney } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { NumericInput } from '@techsio/ui-kit/atoms/numeric-input';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Combobox } from '@techsio/ui-kit/molecules/combobox';
import { FormNumericInput } from '@techsio/ui-kit/molecules/form-numeric-input';
import { useRef, useState } from 'react';
import { opportunityAmountMinor } from '../../../../../shared/model/opportunity.ts';
import type { OpportunityLine } from '../../../../../shared/model/opportunity.ts';
import { firstValue } from './pipeline-model.ts';
import type { LoadState, ProductOption } from './pipeline-references.ts';

const K = 'sales-pipeline.pages.records';

export interface LineEntry {
  readonly key: string;
  readonly line: OpportunityLine;
}

interface PickState {
  readonly productId: string | null;
  readonly quantity: number;
}

interface LinesEditorProps {
  readonly lines: readonly LineEntry[];
  readonly onChange: (lines: readonly LineEntry[]) => void;
  readonly products: LoadState<readonly ProductOption[]>;
}

interface LineRowProps {
  readonly entry: LineEntry;
  readonly onQuantity: (value: number) => void;
  readonly onRemove: () => void;
}

const LineRow = ({ entry, onQuantity, onRemove }: LineRowProps) => {
  const { t } = useModernI18n();
  const { line } = entry;
  return (
    <li className="flex items-center gap-150 rounded-md border border-border-primary p-150">
      <div className="flex min-w-0 flex-1 flex-col gap-50">
        <span className="truncate font-medium text-sm">{line.productName}</span>
        <span className="text-fg-secondary text-xs tabular-nums">
          {t(`${K}.create.lineMeta`, { price: formatMoney(line.unitPriceMinor), vat: line.vatRate })}
        </span>
      </div>
      <div className="w-24 shrink-0">
        <NumericInput locale="cs-CZ" min={1} onChange={onQuantity} size="sm" step={1} value={line.quantity}>
          <NumericInput.Control>
            <NumericInput.Input aria-label={t(`${K}.create.fields.quantity`)} />
          </NumericInput.Control>
        </NumericInput>
      </div>
      <span className="w-28 shrink-0 text-end font-medium text-sm tabular-nums">
        {formatMoney(line.quantity * line.unitPriceMinor)}
      </span>
      <Button
        aria-label={t(`${K}.create.removeLine`)}
        icon="icon-[mdi--delete-outline]"
        onClick={onRemove}
        size="sm"
        theme="borderless"
        type="button"
        variant="secondary"
      />
    </li>
  );
};

/**
 * Product lines of an opportunity. A line copies the product's current price and VAT when it is added;
 * that price then stays on the line, so later price changes do not reach it.
 */
export const LinesEditor = ({ lines, onChange, products }: LinesEditorProps) => {
  const { t } = useModernI18n();
  const [pick, setPick] = useState<PickState>({ productId: null, quantity: 1 });
  const [lineError, setLineError] = useState<string>();
  /** Local React keys for draft lines; never sent to the server. */
  const keySequence = useRef(0);

  const activeProducts = products.status === 'ready' ? products.items.filter((item) => item.active) : [];
  const pickedProduct = activeProducts.find((item) => item.id === pick.productId);
  const productItems = activeProducts.map((product) => ({
    id: product.id,
    label: `${product.sku} – ${product.name}`,
    value: product.id,
  }));
  const total = opportunityAmountMinor(lines.map((entry) => entry.line));

  const addLine = () => {
    if (pickedProduct === undefined) {
      setLineError(t(`${K}.create.errors.productRequired`));
      return;
    }
    setLineError(undefined);
    keySequence.current += 1;
    const entry: LineEntry = {
      key: `line-${keySequence.current}`,
      line: {
        productId: pickedProduct.id,
        productName: pickedProduct.name,
        quantity: pick.quantity,
        unitPriceMinor: pickedProduct.currentPriceMinor,
        vatRate: pickedProduct.vatRate,
      },
    };
    onChange([...lines, entry]);
    setPick({ productId: null, quantity: 1 });
  };

  const setQuantity = (key: string, value: number) => {
    if (!Number.isFinite(value)) {
      return;
    }
    const quantity = Math.max(1, Math.trunc(value));
    onChange(lines.map((entry) => (entry.key === key ? { ...entry, line: { ...entry.line, quantity } } : entry)));
  };

  return (
    <section className="flex flex-col gap-150 border-border-primary border-t pt-200">
      <div className="flex flex-wrap items-baseline justify-between gap-100">
        <h2 className="font-semibold text-md">{t(`${K}.create.fields.lines`)}</h2>
        <span className="text-fg-secondary text-xs">{t(`${K}.create.priceFixedHint`)}</span>
      </div>

      <div className="flex flex-wrap items-end gap-150">
        <div className="flex min-w-0 flex-1 flex-col gap-50">
          <Combobox
            error={products.status === 'error' ? t(`${K}.create.productsFailed`) : undefined}
            items={productItems}
            label={t(`${K}.create.fields.product`)}
            loading={products.status === 'loading'}
            noResultsMessage={t(`${K}.create.noProductMatch`)}
            onChange={(values) => {
              setLineError(undefined);
              setPick((current) => ({ ...current, productId: firstValue(values) ?? null }));
            }}
            placeholder={t(`${K}.create.productPlaceholder`)}
            value={pick.productId === null ? [] : [pick.productId]}
          />
          {pickedProduct !== undefined && (
            <p className="text-fg-secondary text-xs">
              {t(`${K}.create.currentPrice`, {
                price: formatMoney(pickedProduct.currentPriceMinor),
                vat: pickedProduct.vatRate,
              })}
            </p>
          )}
        </div>
        <div className="w-28 shrink-0">
          <FormNumericInput
            id="opportunity-line-quantity"
            label={t(`${K}.create.fields.quantity`)}
            locale="cs-CZ"
            min={1}
            name="lineQuantity"
            onChange={(value) => {
              if (Number.isFinite(value)) {
                setPick((current) => ({ ...current, quantity: Math.max(1, Math.trunc(value)) }));
              }
            }}
            step={1}
            value={pick.quantity}
          >
            <NumericInput.Control>
              <NumericInput.Input />
            </NumericInput.Control>
          </FormNumericInput>
        </div>
        <Button
          disabled={pick.productId === null}
          icon="icon-[mdi--plus]"
          onClick={addLine}
          size="sm"
          theme="outlined"
          type="button"
          variant="secondary"
        >
          {t(`${K}.create.addLine`)}
        </Button>
      </div>
      {lineError !== undefined && (
        <StatusText showIcon status="error">
          {lineError}
        </StatusText>
      )}

      {lines.length === 0 ? (
        <p className="text-fg-secondary text-sm">{t(`${K}.create.noLines`)}</p>
      ) : (
        <ul className="flex flex-col gap-100">
          {lines.map((entry) => (
            <LineRow
              entry={entry}
              key={entry.key}
              onQuantity={(value) => setQuantity(entry.key, value)}
              onRemove={() => onChange(lines.filter((item) => item.key !== entry.key))}
            />
          ))}
        </ul>
      )}

      <div className="flex items-center justify-between gap-150 font-semibold text-sm">
        <span>{t(`${K}.create.total`)}</span>
        <span className="tabular-nums">{formatMoney(total)}</span>
      </div>
    </section>
  );
};
