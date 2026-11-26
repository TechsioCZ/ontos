// Per-variant storefront details: parameters (Akros filters), image, labels, unit, order minimum and package, quantity
// tiers, description, weight and the struck-through price. Edits the variant draft of the Varianty tab in place.
import { Button } from '@techsio/ui-kit/atoms/button';
import { FormInput, FormTextarea, Switch } from '@app/admin-ui/form-controls';
import { SelectTemplate } from '@app/admin-ui/select-template';
import { selectItem } from '../../../../ui/select-item.ts';
import { PriceTierRows } from './product-sales-terms.tsx';
import { nextTierKey, parseQuantityText } from './product-sales-terms-draft.ts';
import type { TierDraft } from './product-sales-terms-draft.ts';

export interface VariantParameterDraft {
  readonly key: number;
  readonly label: string;
  readonly unit: string;
  readonly value: string;
}

export interface VariantFlagsDraft {
  readonly isAction: boolean;
  readonly isNew: boolean;
  readonly isRecommended: boolean;
  readonly isSale: boolean;
}

/** The detail fields of one variant draft, as typed. Empty text means "not set". */
export interface VariantDetailDraft {
  readonly description: string;
  readonly flags: VariantFlagsDraft;
  readonly imageSrc: string;
  readonly minimumQuantityText: string;
  readonly originalPriceText: string;
  readonly packageQuantityText: string;
  readonly parameters: readonly VariantParameterDraft[];
  readonly sourceUnit: string;
  readonly tiers: readonly TierDraft[];
  readonly tiersEdited: boolean;
  readonly unit: string;
  readonly weightGramsText: string;
}

const NO_IMAGE = '__none__';

const flagLabels = [
  ['isAction', 'Akce'],
  ['isNew', 'Novinka'],
  ['isRecommended', 'Doporučujeme'],
  ['isSale', 'Výprodej'],
] as const;

export interface VariantDetailEditorProps {
  readonly disabled: boolean;
  readonly draft: VariantDetailDraft;
  readonly idPrefix: string;
  /** The product gallery (image refs); a variant shows one of them. */
  readonly images: readonly string[];
  readonly onChange: (next: Partial<VariantDetailDraft>) => void;
  readonly vatRate: number | undefined;
}

const imageLabel = (image: string, index: number) => {
  const main = index === 0 ? ' (hlavní)' : '';
  const shown = image.length > 48 ? `…${image.slice(-40)}` : image;
  return `Obrázek ${index + 1}${main} · ${shown}`;
};

/** The row button that opens the detail editor of a variant; it turns red while the details hold the save back. */
export const VariantDetailsToggle = ({
  invalid,
  onToggle,
  open,
}: {
  readonly invalid: boolean;
  readonly onToggle: () => void;
  readonly open: boolean;
}) => (
  <Button
    onClick={onToggle}
    size="sm"
    theme={invalid ? 'solid' : 'borderless'}
    type="button"
    variant={invalid ? 'danger' : 'secondary'}
  >
    {open ? 'Skrýt podrobnosti' : 'Podrobnosti'}
  </Button>
);

export const VariantDetailEditor = ({
  disabled,
  draft,
  idPrefix,
  images,
  onChange,
  vatRate,
}: VariantDetailEditorProps) => {
  const imageChoices = draft.imageSrc !== '' && !images.includes(draft.imageSrc) ? [...images, draft.imageSrc] : images;
  const patchParameter = (key: number, next: Partial<VariantParameterDraft>) =>
    onChange({
      parameters: draft.parameters.map((parameter) => (parameter.key === key ? { ...parameter, ...next } : parameter)),
    });
  let nextParameterKey = 0;
  for (const parameter of draft.parameters) {
    nextParameterKey = Math.max(nextParameterKey, parameter.key + 1);
  }
  const minimum = parseQuantityText(draft.minimumQuantityText);
  return (
    <div className="flex flex-col gap-200 p-200">
      <div className="flex flex-col gap-100">
        <h3 className="font-semibold text-sm">Parametry varianty (filtry v e-shopu)</h3>
        {draft.parameters.map((parameter, index) => (
          <div
            className="grid grid-cols-1 items-end gap-100 sm:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_minmax(0,1fr)_auto]"
            key={parameter.key}
          >
            <FormInput
              disabled={disabled}
              id={`${idPrefix}-param-label-${parameter.key}`}
              label="Název parametru"
              name={`${idPrefix}-param-label-${parameter.key}`}
              onChange={(event) => patchParameter(parameter.key, { label: event.target.value })}
              size="sm"
              value={parameter.label}
            />
            <FormInput
              disabled={disabled}
              id={`${idPrefix}-param-value-${parameter.key}`}
              label="Hodnota"
              name={`${idPrefix}-param-value-${parameter.key}`}
              onChange={(event) => patchParameter(parameter.key, { value: event.target.value })}
              size="sm"
              value={parameter.value}
            />
            <FormInput
              disabled={disabled}
              id={`${idPrefix}-param-unit-${parameter.key}`}
              label="Jednotka"
              name={`${idPrefix}-param-unit-${parameter.key}`}
              onChange={(event) => patchParameter(parameter.key, { unit: event.target.value })}
              size="sm"
              value={parameter.unit}
            />
            {disabled ? null : (
              <Button
                aria-label={`Odebrat parametr ${index + 1}`}
                icon="icon-[mdi--delete-outline]"
                onClick={() =>
                  onChange({ parameters: draft.parameters.filter((entry) => entry.key !== parameter.key) })
                }
                size="sm"
                theme="borderless"
                type="button"
                variant="secondary"
              />
            )}
          </div>
        ))}
        {disabled ? null : (
          <div>
            <Button
              icon="icon-[mdi--plus]"
              onClick={() =>
                onChange({
                  parameters: [...draft.parameters, { key: nextParameterKey, label: '', unit: '', value: '' }],
                })
              }
              size="sm"
              theme="outlined"
              type="button"
              variant="secondary"
            >
              Přidat parametr
            </Button>
          </div>
        )}
      </div>
      <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
        <SelectTemplate
          disabled={disabled}
          items={[
            selectItem(NO_IMAGE, 'bez obrázku'),
            ...imageChoices.map((image, index) => selectItem(image, imageLabel(image, index))),
          ]}
          label="Obrázek varianty"
          name={`${idPrefix}-image`}
          onValueChange={(details) => {
            const [next] = details.value;
            onChange({ imageSrc: next === undefined || next === NO_IMAGE ? '' : next });
          }}
          placeholder="bez obrázku"
          size="sm"
          value={[draft.imageSrc === '' ? NO_IMAGE : draft.imageSrc]}
        />
        <div className="flex flex-wrap items-end gap-200">
          {flagLabels.map(([flag, label]) => (
            <Switch
              checked={draft.flags[flag]}
              disabled={disabled}
              key={flag}
              name={`${idPrefix}-${flag}`}
              onCheckedChange={(checked: boolean) => onChange({ flags: { ...draft.flags, [flag]: checked } })}
            >
              {label}
            </Switch>
          ))}
        </div>
        <FormInput
          disabled={disabled}
          helpText="Zároveň násobek, po kterém se varianta objednává. Prázdné = 1."
          id={`${idPrefix}-minimum`}
          inputMode="decimal"
          label="Minimální odběr"
          name={`${idPrefix}-minimum`}
          onChange={(event) => onChange({ minimumQuantityText: event.target.value })}
          size="sm"
          value={draft.minimumQuantityText}
        />
        <FormInput
          disabled={disabled}
          id={`${idPrefix}-package`}
          inputMode="decimal"
          label="Počet v balení"
          name={`${idPrefix}-package`}
          onChange={(event) => onChange({ packageQuantityText: event.target.value })}
          size="sm"
          value={draft.packageQuantityText}
        />
        <FormInput
          disabled={disabled}
          id={`${idPrefix}-unit`}
          label="Jednotka"
          name={`${idPrefix}-unit`}
          onChange={(event) => onChange({ unit: event.target.value })}
          size="sm"
          value={draft.unit}
        />
        <FormInput
          disabled={disabled}
          helpText="Jednotka zobrazená v e-shopu, má přednost před jednotkou."
          id={`${idPrefix}-source-unit`}
          label="Jednotka v e-shopu"
          name={`${idPrefix}-source-unit`}
          onChange={(event) => onChange({ sourceUnit: event.target.value })}
          size="sm"
          value={draft.sourceUnit}
        />
        <FormInput
          disabled={disabled}
          helpText="0 nebo prázdné = neuvádět."
          id={`${idPrefix}-weight`}
          inputMode="numeric"
          label="Hmotnost (g)"
          name={`${idPrefix}-weight`}
          onChange={(event) => onChange({ weightGramsText: event.target.value })}
          size="sm"
          value={draft.weightGramsText}
        />
        <FormInput
          disabled={disabled}
          helpText="Prázdné = žádná."
          id={`${idPrefix}-original-price`}
          inputMode="decimal"
          label="Původní cena s DPH (přeškrtnutá, Kč)"
          name={`${idPrefix}-original-price`}
          onChange={(event) => onChange({ originalPriceText: event.target.value })}
          size="sm"
          value={draft.originalPriceText}
        />
      </div>
      <FormTextarea
        disabled={disabled}
        id={`${idPrefix}-description`}
        label="Popis varianty"
        maxLength={2000}
        name={`${idPrefix}-description`}
        onChange={(event) => onChange({ description: event.target.value })}
        value={draft.description}
      />
      <div className="flex flex-col gap-100">
        <h3 className="font-semibold text-sm">Množstevní ceny varianty</h3>
        <PriceTierRows
          disabled={disabled}
          idPrefix={idPrefix}
          minimum={minimum ?? 1}
          onChange={(tiers) => onChange({ tiers, tiersEdited: true })}
          tiers={draft.tiers}
          vatRate={vatRate}
        />
        {draft.tiers.length > 0 && nextTierKey(draft.tiers) > 0 && !draft.tiersEdited ? (
          <p className="text-fg-secondary text-xs">Při změně ceny varianty se množstevní ceny přepočítají.</p>
        ) : null}
      </div>
    </div>
  );
};
