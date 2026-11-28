// Sales terms of one product as the storefront shows them: order minimum (also the order increment on Akros), package
// quantity, the unit label, quantity price tiers and the struck-through original price.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { SectionCard } from '@app/admin-ui';
import {
  FormBuilder,
  FormReact,
  FormRoot,
  TextField,
  TextLensField,
  useAtomSet,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import type { TextLensProps } from '@app/core-runtime/ui/form';
import { DateTime, Effect, Option, Schema } from 'effect';
import { Atom } from 'effect/reactivity';
import type { FC } from 'react';
import type { ProductPatch } from '../../../../../shared/actions/apply-command.ts';
import type { ProductRecord } from '../../../../../shared/apis/records.ts';
import { grossUnitPriceMinor } from '../../../../../shared/domain/merchandise-model.ts';
import { browserAtomRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import {
  TierDraftSchema,
  czkText,
  nextTierKey,
  parseCzkText,
  parseQuantityText,
  priceTiersOf,
  sameTiers,
  tierDraftsOf,
  tierRowsInvalid,
  tiersAtMinimum,
  tiersAtMinimumNote,
} from './product-sales-terms-draft.ts';
import type { TierDraft } from './product-sales-terms-draft.ts';
import { fieldVerdict } from './product-form-validation.ts';
import { ProductTabSaveBar, useProductTabSave } from './product-tab-save.tsx';
import { productVersionOf } from './products-api.ts';
import { DEFAULT_TAX_CLASSIFICATION, rateAt } from './product-tax-classification.ts';
import type { CompanyVat } from './product-tax-classification.ts';

export interface PriceTierRowsProps<Value> {
  readonly disabled: boolean;
  /** The field's value with `next` as its tier rows: a typed, added or removed row. */
  readonly edit: (value: Value, next: readonly TierDraft[]) => Value;
  /** The form field holding the rows; one input per tier value reads and writes its part of it. */
  readonly field: FC<TextLensProps<Value>>;
  readonly idPrefix: string;
  readonly minimum: number | null;
  /** A row was added or removed: the rows the field holds next. */
  readonly onChange: (next: readonly TierDraft[]) => void;
  /** The rows the field's value shows: as they sell at the current minimum. */
  readonly shownOf: (value: Value) => readonly TierDraft[];
  /** The rows shown now. */
  readonly tiers: readonly TierDraft[];
  /** The rate the gross price is pre-filled with from the net price. */
  readonly vatRate: number | undefined;
}

type TierText = Exclude<keyof TierDraft, 'key'>;

/** Row editor of quantity tiers ("Od N ks"). Gross is pre-filled from net × VAT and stays editable. */
export const PriceTierRows = <Value,>({
  disabled,
  edit,
  field: TierField,
  idPrefix,
  minimum,
  onChange,
  shownOf,
  tiers,
  vatRate,
}: PriceTierRowsProps<Value>) => {
  /** The input of one text of one row: it shows the row as shown and writes the shown rows with it typed. */
  const part = (key: number, text: TierText, patch: (tier: TierDraft, typed: string) => TierDraft) => ({
    read: (value: Value) => shownOf(value).find((tier) => tier.key === key)?.[text] ?? '',
    write: (value: Value, typed: string) =>
      edit(
        value,
        shownOf(value).map((tier) => (tier.key === key ? patch(tier, typed) : tier)),
      ),
  });
  const withNet = (tier: TierDraft, typed: string): TierDraft => {
    const net = parseCzkText(typed);
    return net === null || vatRate === undefined
      ? { ...tier, netText: typed }
      : { ...tier, grossText: czkText(grossUnitPriceMinor(net, vatRate)), netText: typed };
  };
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
            <TierField
              disabled={disabled}
              id={`${idPrefix}-tier-min-${tier.key}`}
              inputMode="decimal"
              label="Od množství"
              name={`${idPrefix}-tier-min-${tier.key}`}
              size="sm"
              {...part(tier.key, 'minimumText', (row, typed) => ({ ...row, minimumText: typed }))}
              {...fieldVerdict(fromInvalid, 'Nesmí být menší než minimální odběr')}
            />
            <TierField
              disabled={disabled}
              id={`${idPrefix}-tier-net-${tier.key}`}
              inputMode="decimal"
              label="Cena bez DPH (Kč)"
              name={`${idPrefix}-tier-net-${tier.key}`}
              size="sm"
              {...part(tier.key, 'netText', withNet)}
            />
            <TierField
              disabled={disabled}
              id={`${idPrefix}-tier-gross-${tier.key}`}
              inputMode="decimal"
              label="Cena s DPH (Kč)"
              name={`${idPrefix}-tier-gross-${tier.key}`}
              size="sm"
              {...part(tier.key, 'grossText', (row, typed) => ({ ...row, grossText: typed }))}
            />
            {disabled ? null : (
              <Button
                appearance="ghost"
                aria-label={`Odebrat množstevní cenu ${index + 1}`}
                icon="icon-[mdi--delete-outline]"
                onClick={() => onChange(tiers.filter((entry) => entry.key !== tier.key))}
                severity="secondary"
                size="sm"
                type="button"
              />
            )}
          </div>
        );
      })}
      {disabled ? null : (
        <div>
          <Button
            appearance="outline"
            icon="icon-[mdi--plus]"
            onClick={() =>
              onChange([
                ...tiers,
                { grossText: '', key: nextKey, minimumText: String((minimum ?? 1) * 10), netText: '' },
              ])
            }
            severity="secondary"
            size="sm"
            type="button"
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
  /** The minimum `tiers` were written for: the rows follow a minimum changed since ({@link tiersAtMinimum}). */
  readonly tiersMinimumText: string;
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
  tiersMinimumText: String(product.minimumQuantity ?? 1),
});

/** The tier rows the draft saves: its rows as they sell at its minimum. */
const shownTiersOf = (draft: SalesTermsDraft): readonly TierDraft[] =>
  tiersAtMinimum(draft.tiers, parseQuantityText(draft.tiersMinimumText), parseQuantityText(draft.minimumText));

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
    tierRowsInvalid(shownTiersOf(draft), minimum)
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
  const tiers = priceTiersOf(shownTiersOf(draft));
  if (!sameTiers(tiers, priceTiersOf(shownTiersOf(confirmed)))) {
    patch.priceTiers = tiers;
  }
  return patch;
};

/** The tier rows of the sales terms: the rows as typed and the minimum they were written for. */
const SalesTiersSchema = Schema.Struct({ minimumText: Schema.String, rows: Schema.Array(TierDraftSchema) });
type SalesTiers = typeof SalesTiersSchema.Encoded;

/**
 * The sales terms of the open product. Typing changes only this form; the tab's Save button sends it, so the form
 * itself is never submitted.
 */
const salesTermsForm = FormReact.make(
  FormBuilder.empty
    .addField('minimumText', Schema.String)
    .addField('originalText', Schema.String)
    .addField('packageText', Schema.String)
    .addField('sourceUnit', Schema.String)
    .addField('tiers', SalesTiersSchema),
  {
    fields: {
      minimumText: TextField,
      originalText: TextField,
      packageText: TextField,
      sourceUnit: TextField,
      tiers: TextLensField<SalesTiers>,
    },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);
type SalesTermsValues = typeof salesTermsForm.schema.Encoded;

const salesTermsValuesOf = (draft: SalesTermsDraft): SalesTermsValues => ({
  minimumText: draft.minimumText,
  originalText: draft.originalText,
  packageText: draft.packageText,
  sourceUnit: draft.sourceUnit,
  tiers: { minimumText: draft.tiersMinimumText, rows: draft.tiers },
});

const salesTermsDraft = salesTermsForm.values.pipe(
  Atom.map(
    Option.map((values): SalesTermsDraft => ({
      minimumText: values.minimumText,
      originalText: values.originalText,
      packageText: values.packageText,
      sourceUnit: values.sourceUnit,
      tiers: values.tiers.rows,
      tiersMinimumText: values.tiers.minimumText,
    })),
  ),
);
const salesTiersField = salesTermsForm.getFieldAtoms(salesTermsForm.fields.tiers);

export interface SalesTermsPanelProps {
  readonly active?: boolean;
  readonly canWrite: boolean;
  readonly onCommitted: (message: string) => void;
  readonly onReload: () => void;
  readonly product: ProductRecord;
  readonly revision: number;
  readonly vat: CompanyVat;
}

const SalesTermsFields = ({
  active = true,
  canWrite,
  onCommitted,
  onReload,
  product,
  revision,
  vat,
}: SalesTermsPanelProps) => {
  const form = Option.getOrElse(useAtomValue(salesTermsDraft), () => salesTermsDraftOf(product));
  const setValues = useAtomSet(salesTermsForm.setValues);
  const setTiers = useAtomSet(salesTiersField.setValue);
  const save = useProductTabSave<SalesTermsDraft>({
    commandOf: (value, confirmed) => ({
      _tag: 'UpdateProduct',
      id: product.id,
      patch: salesTermsPatchOf(value, confirmed, product),
    }),
    isValid: (value) => !salesTermsInvalid(value, product),
    keepAs: `sales-terms:${product.id}`,
    onReload,
    onSaved: () => onCommitted('Prodejní podmínky uloženy. Změnu uvidí zákazník po obnovení stránky.'),
    reset: (next) => setValues(salesTermsValuesOf(next)),
    revision,
    server: salesTermsDraftOf(product),
    value: form,
    version: productVersionOf(product),
  });
  const variants = hasRealVariants(product);
  const disabled = !canWrite;
  const minimum = parseQuantityText(form.minimumText);
  const vatRate = rateAt(
    vat,
    product.taxClassificationCode ?? DEFAULT_TAX_CLASSIFICATION,
    DateTime.nowUnsafe(),
  )?.ratePercent;
  const invalid = salesTermsInvalid(form, product);
  const shownTiers = shownTiersOf(form);
  const tiersNote = tiersAtMinimumNote(form.tiers, shownTiers, minimum);
  const shownOf = (value: SalesTiers) => tiersAtMinimum(value.rows, parseQuantityText(value.minimumText), minimum);
  const editTiers = (value: SalesTiers, next: readonly TierDraft[]): SalesTiers => ({
    minimumText: minimum === null ? value.minimumText : form.minimumText,
    rows: next,
  });
  return (
    <>
      <SectionCard title="Prodejní podmínky v e-shopu">
        <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
          <salesTermsForm.originalText
            disabled={disabled}
            helpText="Prázdné = žádná. Zobrazí se přeškrtnutá vedle aktuální ceny."
            id="sales-original-price"
            inputMode="decimal"
            label="Původní cena s DPH (přeškrtnutá)"
            name="originalPrice"
          />
          {variants ? (
            <p className="text-fg-secondary text-sm">
              Jednotku zobrazenou v e-shopu nastavte u každé varianty v Varianty › Podrobnosti.
            </p>
          ) : (
            <salesTermsForm.sourceUnit
              disabled={disabled}
              helpText={`Prázdné = jednotka produktu (${product.unit}).`}
              id="sales-source-unit"
              label="Jednotka zobrazená v e-shopu"
              maxLength={40}
              name="sourceUnit"
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
            <salesTermsForm.minimumText
              disabled={disabled}
              id="sales-minimum"
              inputMode="decimal"
              label="Minimální odběr (zároveň násobek v e-shopu)"
              name="minimumQuantity"
              {...fieldVerdict(minimum === null, 'Zadejte číslo větší než 0')}
            />
            <salesTermsForm.packageText
              disabled={disabled}
              id="sales-package"
              inputMode="decimal"
              label="Počet v balení"
              name="packageQuantity"
            />
          </div>
        )}
      </SectionCard>
      {variants ? null : (
        <SectionCard title={`Množstevní ceny (${shownTiers.length})`}>
          <PriceTierRows
            disabled={disabled}
            edit={editTiers}
            field={salesTermsForm.tiers}
            idPrefix="product"
            minimum={minimum}
            onChange={(next) => setTiers(editTiers({ minimumText: form.tiersMinimumText, rows: form.tiers }, next))}
            shownOf={shownOf}
            tiers={shownTiers}
            vatRate={vatRate}
          />
          {tiersNote === null ? null : <p className="mt-150 text-fg-secondary text-sm">{tiersNote}</p>}
        </SectionCard>
      )}
      {invalid ? (
        <StatusText showIcon status="error">
          Opravte zvýrazněné údaje prodejních podmínek.
        </StatusText>
      ) : null}
      {canWrite ? <ProductTabSaveBar active={active} save={save} /> : null}
    </>
  );
};

/** Sales terms editor: one draft, one Uložit sending one UpdateProduct. */
export const SalesTermsPanel = (props: SalesTermsPanelProps) => {
  const { t } = useModernI18n();
  return (
    <FormRoot
      className="flex flex-col gap-250"
      defaultValues={salesTermsValuesOf(salesTermsDraftOf(props.product))}
      form={salesTermsForm}
      translateMessage={t}
    >
      <SalesTermsFields {...props} />
    </FormRoot>
  );
};
