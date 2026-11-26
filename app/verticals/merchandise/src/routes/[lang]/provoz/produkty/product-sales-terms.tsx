// Sales terms of one product as the storefront shows them: order minimum (also the order increment on Akros), package
// quantity, the unit label, quantity price tiers and the struck-through original price.
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@app/admin-ui/form-controls';
import { SectionCard } from '@app/admin-ui';
import { DateTime } from 'effect';
import { useState } from 'react';
import type { ProductPatch } from '../../../../../shared/actions/apply-command.ts';
import type { ProductRecord } from '../../../../../shared/apis/records.ts';
import { grossUnitPriceMinor } from '../../../../../shared/domain/merchandise-model.ts';
import {
  czkText,
  nextTierKey,
  parseCzkText,
  parseQuantityText,
  priceTiersOf,
  sameTiers,
  tierDraftsOf,
  tierRowsInvalid,
} from './product-sales-terms-draft.ts';
import type { TierDraft } from './product-sales-terms-draft.ts';
import { fieldError } from './product-form-validation.ts';
import { ProductTabSaveBar, useProductTabSave } from './product-tab-save.tsx';
import { DEFAULT_TAX_CLASSIFICATION, rateAt } from './product-tax-classification.ts';
import type { CompanyVat } from './product-tax-classification.ts';

export interface PriceTierRowsProps {
  readonly disabled: boolean;
  readonly idPrefix: string;
  readonly minimum: number | null;
  readonly onChange: (next: readonly TierDraft[]) => void;
  readonly tiers: readonly TierDraft[];
  /** The rate the gross price is pre-filled with from the net price. */
  readonly vatRate: number | undefined;
}

/** Row editor of quantity tiers ("Od N ks"). Gross is pre-filled from net × VAT and stays editable. */
export const PriceTierRows = ({ disabled, idPrefix, minimum, onChange, tiers, vatRate }: PriceTierRowsProps) => {
  const patch = (key: number, next: Partial<TierDraft>) =>
    onChange(tiers.map((tier) => (tier.key === key ? { ...tier, ...next } : tier)));
  const nextKey = nextTierKey(tiers);
  return (
    <div className="flex flex-col gap-100">
      {tiers.length === 0 ? <p className="text-fg-secondary text-sm">Žádné množstevní ceny.</p> : null}
      {tiers.map((tier, index) => {
        const from = parseQuantityText(tier.minimumText);
        const fromInvalid = from === null || (minimum !== null && from < minimum);
        return (
          <div
            className="grid grid-cols-1 items-end gap-100 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"
            key={tier.key}
          >
            <FormInput
              disabled={disabled}
              id={`${idPrefix}-tier-min-${tier.key}`}
              inputMode="decimal"
              label="Od množství"
              name={`${idPrefix}-tier-min-${tier.key}`}
              onChange={(event) => patch(tier.key, { minimumText: event.target.value })}
              size="sm"
              value={tier.minimumText}
              {...fieldError(fromInvalid, 'Nesmí být menší než minimální odběr')}
            />
            <FormInput
              disabled={disabled}
              id={`${idPrefix}-tier-net-${tier.key}`}
              inputMode="decimal"
              label="Cena bez DPH (Kč)"
              name={`${idPrefix}-tier-net-${tier.key}`}
              onChange={(event) => {
                const net = parseCzkText(event.target.value);
                if (net === null || vatRate === undefined) {
                  patch(tier.key, { netText: event.target.value });
                } else {
                  patch(tier.key, {
                    grossText: czkText(grossUnitPriceMinor(net, vatRate)),
                    netText: event.target.value,
                  });
                }
              }}
              size="sm"
              value={tier.netText}
            />
            <FormInput
              disabled={disabled}
              id={`${idPrefix}-tier-gross-${tier.key}`}
              inputMode="decimal"
              label="Cena s DPH (Kč)"
              name={`${idPrefix}-tier-gross-${tier.key}`}
              onChange={(event) => patch(tier.key, { grossText: event.target.value })}
              size="sm"
              value={tier.grossText}
            />
            {disabled ? null : (
              <Button
                aria-label={`Odebrat množstevní cenu ${index + 1}`}
                icon="icon-[mdi--delete-outline]"
                onClick={() => onChange(tiers.filter((entry) => entry.key !== tier.key))}
                size="sm"
                theme="borderless"
                type="button"
                variant="secondary"
              />
            )}
          </div>
        );
      })}
      {disabled ? null : (
        <div>
          <Button
            icon="icon-[mdi--plus]"
            onClick={() =>
              onChange([
                ...tiers,
                { grossText: '', key: nextKey, minimumText: String((minimum ?? 1) * 10), netText: '' },
              ])
            }
            size="sm"
            theme="outlined"
            type="button"
            variant="secondary"
          >
            Přidat množstevní cenu
          </Button>
        </div>
      )}
    </div>
  );
};

interface SalesTermsDraft {
  readonly minimumText: string;
  readonly originalText: string;
  readonly packageText: string;
  readonly sourceUnit: string;
  readonly tiers: readonly TierDraft[];
}

const salesTermsDraftOf = (product: ProductRecord): SalesTermsDraft => ({
  minimumText: String(product.minimumQuantity ?? 1),
  originalText:
    product.originalPriceMinor === undefined || product.originalPriceMinor === 0
      ? ''
      : czkText(product.originalPriceMinor),
  packageText:
    product.packageQuantity === undefined || product.packageQuantity <= 0 ? '' : String(product.packageQuantity),
  sourceUnit: product.sourceUnit ?? '',
  tiers: tierDraftsOf(product.priceTiers),
});

const hasRealVariants = (product: ProductRecord) => (product.variantRecords ?? []).length > 0;

const salesTermsInvalid = (draft: SalesTermsDraft, product: ProductRecord): boolean => {
  if (draft.originalText.trim() !== '' && parseCzkText(draft.originalText) === null) {
    return true;
  }
  if (draft.sourceUnit.trim().length > 40) {
    return true;
  }
  if (hasRealVariants(product)) {
    return false;
  }
  const minimum = parseQuantityText(draft.minimumText);
  return (
    minimum === null ||
    (draft.packageText.trim() !== '' && parseQuantityText(draft.packageText) === null) ||
    tierRowsInvalid(draft.tiers, minimum)
  );
};

/** Only the changed sales terms. A patch cannot delete a key: an emptied unit sends the product's unit, no price 0. */
const salesTermsPatchOf = (
  draft: SalesTermsDraft,
  confirmed: SalesTermsDraft,
  product: ProductRecord,
): ProductPatch => {
  const patch: { -readonly [Key in keyof ProductPatch]: ProductPatch[Key] } = {};
  const sourceUnit = draft.sourceUnit.trim();
  if (sourceUnit !== confirmed.sourceUnit.trim()) {
    if (sourceUnit !== '') {
      patch.sourceUnit = sourceUnit;
    } else if (product.sourceUnit !== undefined) {
      patch.sourceUnit = product.unit;
    }
  }
  if (draft.originalText.trim() !== confirmed.originalText.trim()) {
    patch.originalPriceMinor = parseCzkText(draft.originalText) ?? 0;
  }
  if (hasRealVariants(product)) {
    return patch;
  }
  const minimum = parseQuantityText(draft.minimumText) ?? 1;
  if (minimum !== parseQuantityText(confirmed.minimumText)) {
    patch.minimumQuantity = minimum;
  }
  // An emptied package sends 0 (no package): the owner treats only a positive package as a step.
  const packageQuantity = draft.packageText.trim() === '' ? 0 : parseQuantityText(draft.packageText);
  if (packageQuantity !== null && packageQuantity !== (parseQuantityText(confirmed.packageText) ?? 0)) {
    patch.packageQuantity = packageQuantity;
  }
  const tiers = priceTiersOf(draft.tiers);
  if (!sameTiers(tiers, priceTiersOf(confirmed.tiers))) {
    patch.priceTiers = tiers;
  }
  return patch;
};

export interface SalesTermsPanelProps {
  readonly active?: boolean;
  readonly canWrite: boolean;
  readonly onCommitted: (message: string) => void;
  readonly onReload: () => void;
  readonly product: ProductRecord;
  readonly revision: number;
  readonly vat: CompanyVat;
}

/** Sales terms editor: one draft, one Uložit sending one UpdateProduct. */
export const SalesTermsPanel = ({
  active = true,
  canWrite,
  onCommitted,
  onReload,
  product,
  revision,
  vat,
}: SalesTermsPanelProps) => {
  const [form, setForm] = useState<SalesTermsDraft>(() => salesTermsDraftOf(product));
  const save = useProductTabSave<SalesTermsDraft>({
    commandOf: (value, confirmed) => ({
      _tag: 'UpdateProduct',
      id: product.id,
      patch: salesTermsPatchOf(value, confirmed, product),
    }),
    isValid: (value) => !salesTermsInvalid(value, product),
    onReload,
    onSaved: () => onCommitted('Prodejní podmínky uloženy. Změnu uvidí zákazník po obnovení stránky.'),
    reset: setForm,
    revision,
    server: salesTermsDraftOf(product),
    value: form,
  });
  const set = (next: Partial<SalesTermsDraft>) => setForm((current) => ({ ...current, ...next }));
  const variants = hasRealVariants(product);
  const disabled = !canWrite;
  const minimum = parseQuantityText(form.minimumText);
  const vatRate = rateAt(
    vat,
    product.taxClassificationCode ?? DEFAULT_TAX_CLASSIFICATION,
    DateTime.nowUnsafe(),
  )?.ratePercent;
  const invalid = salesTermsInvalid(form, product);
  return (
    <div className="flex flex-col gap-250">
      <SectionCard title="Prodejní podmínky v e-shopu">
        <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
          <FormInput
            disabled={disabled}
            helpText="Prázdné = žádná. Zobrazí se přeškrtnutá vedle aktuální ceny."
            id="sales-original-price"
            inputMode="decimal"
            label="Původní cena s DPH (přeškrtnutá)"
            name="originalPrice"
            onChange={(event) => set({ originalText: event.target.value })}
            value={form.originalText}
          />
          {variants ? (
            <p className="text-fg-secondary text-sm">
              Jednotku zobrazenou v e-shopu nastavte u každé varianty v Varianty › Podrobnosti.
            </p>
          ) : (
            <FormInput
              disabled={disabled}
              helpText={`Prázdné = jednotka produktu (${product.unit}).`}
              id="sales-source-unit"
              label="Jednotka zobrazená v e-shopu"
              maxLength={40}
              name="sourceUnit"
              onChange={(event) => set({ sourceUnit: event.target.value })}
              value={form.sourceUnit}
            />
          )}
        </div>
        {variants ? (
          <p className="mt-150 text-fg-secondary text-sm">
            Produkt má prodejní varianty: minimální odběr, balení a množstevní ceny upravte na kartě Varianty (tlačítko
            Podrobnosti u varianty).
          </p>
        ) : (
          <div className="mt-200 grid grid-cols-1 gap-200 sm:grid-cols-2">
            <FormInput
              disabled={disabled}
              id="sales-minimum"
              inputMode="decimal"
              label="Minimální odběr (zároveň násobek v e-shopu)"
              name="minimumQuantity"
              onChange={(event) => set({ minimumText: event.target.value })}
              value={form.minimumText}
              {...fieldError(minimum === null, 'Zadejte číslo větší než 0')}
            />
            <FormInput
              disabled={disabled}
              id="sales-package"
              inputMode="decimal"
              label="Počet v balení"
              name="packageQuantity"
              onChange={(event) => set({ packageText: event.target.value })}
              value={form.packageText}
            />
          </div>
        )}
      </SectionCard>
      {variants ? null : (
        <SectionCard title={`Množstevní ceny (${form.tiers.length})`}>
          <PriceTierRows
            disabled={disabled}
            idPrefix="product"
            minimum={minimum}
            onChange={(tiers) => set({ tiers })}
            tiers={form.tiers}
            vatRate={vatRate}
          />
        </SectionCard>
      )}
      {invalid ? (
        <StatusText showIcon status="error">
          Opravte zvýrazněné údaje prodejních podmínek.
        </StatusText>
      ) : null}
      {canWrite ? <ProductTabSaveBar active={active} save={save} /> : null}
    </div>
  );
};
