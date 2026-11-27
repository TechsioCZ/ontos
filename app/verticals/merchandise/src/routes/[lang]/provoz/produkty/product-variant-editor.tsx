// Per-variant storefront details: parameters (Akros filters), image (any photo of the product's photo library, picked
// by its thumbnail, or a new upload), labels, unit, order minimum and package, quantity tiers, description, weight and
// the struck-through price. Edits the variant draft of the Varianty tab in place.
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FileUpload } from '@techsio/ui-kit/molecules/file-upload';
import { surfaceTileClassName } from '@app/admin-ui';
import { FormInput, FormTextarea, Switch } from '@app/admin-ui/form-controls';
import { Option } from 'effect';
import type { ReactNode } from 'react';
import type { ProductId } from '../../../../../shared/domain/merchandise-model.ts';
import { mediaAssetIdOf } from '../../../../../shared/domain/product-images.ts';
import { useVariantPhotoUpload } from './product-image-gallery-draft.ts';
import { ACCEPTED_IMAGE_TYPES, MAX_SOURCE_IMAGE_BYTES } from './product-image-prepare.ts';
import { useImageSource } from './product-image-source.ts';
import { PriceTierRows } from './product-sales-terms.tsx';
import {
  nextTierKey,
  parseQuantityText,
  tiersAtMinimumNote,
  variantMinimumOf,
  variantTiersShown,
} from './product-sales-terms-draft.ts';
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
  /** The minimum `tiers` were written for: the rows follow a minimum changed since ({@link variantTiersShown}). */
  readonly tiersMinimumText: string;
  readonly unit: string;
  readonly weightGramsText: string;
}

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
  /** The product's photos (image refs): the gallery first, then the photo library the server keeps. */
  readonly images: readonly string[];
  /** The product's main photo, the first gallery image: the only one marked "Hlavní"; none with an empty gallery. */
  readonly mainImage: string | undefined;
  readonly onChange: (next: Partial<VariantDetailDraft>) => void;
  readonly productId: ProductId;
  readonly vatRate: number | undefined;
}

/** The name under a photo's thumbnail: an imported photo's file name; an uploaded one has no name of its own. */
const photoCaptionOf = (image: string) => {
  if (Option.isSome(mediaAssetIdOf(image))) {
    return 'Nahraný obrázek';
  }
  const name = image.split('/').at(-1);
  return name === undefined || name === '' ? image : name;
};

/** One choice of the variant photo: a square tile, a caption under it, a primary ring around the chosen one. */
const ImageChoice = ({
  caption,
  children,
  disabled,
  onPick,
  selected,
}: {
  readonly caption: string;
  readonly children: ReactNode;
  readonly disabled: boolean;
  readonly onPick: () => void;
  readonly selected: boolean;
}) => (
  <li className="min-w-0">
    <button
      aria-pressed={selected}
      className={`flex w-full flex-col gap-50 rounded-lg p-50 text-left text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed ${selected ? 'ring-2 ring-primary' : 'enabled:hover:bg-fill-hover'}`}
      data-testid="variant-image-choice"
      disabled={disabled}
      onClick={onPick}
      type="button"
    >
      <span
        className={`${surfaceTileClassName} relative flex aspect-square w-full items-center justify-center overflow-hidden`}
      >
        {children}
      </span>
      <span className="line-clamp-2 break-all" data-testid="variant-image-caption">
        {caption}
      </span>
    </button>
  </li>
);

/** A photo of the product as a thumbnail the operator can recognise, marked "Hlavní" when it is the main photo. */
const VariantImageTile = ({
  disabled,
  image,
  main,
  onPick,
  productId,
  selected,
}: {
  readonly disabled: boolean;
  readonly image: string;
  readonly main: boolean;
  readonly onPick: () => void;
  readonly productId: ProductId;
  readonly selected: boolean;
}) => {
  const source = useImageSource(productId, image, 'thumbnail');
  return (
    <ImageChoice caption={photoCaptionOf(image)} disabled={disabled} onPick={onPick} selected={selected}>
      {source.status === 'ready' ? (
        <img alt="" className="size-full object-contain" loading="lazy" src={source.src} />
      ) : (
        <span className="p-100 text-center text-fg-secondary">
          {source.status === 'loading' ? 'Načítám náhled…' : 'Náhled není k dispozici'}
        </span>
      )}
      {main ? (
        <span className="absolute top-100 left-100">
          <Badge severity="info" size="sm">
            Hlavní
          </Badge>
        </span>
      ) : null}
    </ImageChoice>
  );
};

/** Uploads a new photo for the variant; the stored photo becomes the variant's image in the draft. */
const VariantPhotoUploadButton = ({
  name,
  onStored,
  productId,
}: {
  readonly name: string;
  readonly onStored: (image: string) => void;
  readonly productId: ProductId;
}) => {
  const { reject, start, upload } = useVariantPhotoUpload(productId, onStored);
  const uploading = upload.status === 'uploading';
  return (
    <div className="flex flex-col gap-50">
      <FileUpload
        accept={ACCEPTED_IMAGE_TYPES}
        acceptedFiles={[]}
        disabled={uploading}
        maxFiles={1}
        maxFileSize={MAX_SOURCE_IMAGE_BYTES}
        name={name}
        onFileAccept={({ files }) => {
          const [file] = files;
          if (file !== undefined) {
            start(file);
          }
        }}
        onFileReject={({ files }) => {
          const [rejected] = files;
          if (rejected !== undefined) {
            reject(rejected.file.name, rejected.errors);
          }
        }}
        size="sm"
      >
        <FileUpload.Trigger disabled={uploading} icon="icon-[mdi--image-plus-outline]">
          {uploading ? 'Nahrávám obrázek…' : 'Nahrát nový obrázek'}
        </FileUpload.Trigger>
        <FileUpload.HiddenInput />
      </FileUpload>
      {upload.status === 'failed' ? (
        <StatusText showIcon status="error">
          {upload.message}
        </StatusText>
      ) : null}
    </div>
  );
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
    appearance={invalid ? 'solid' : 'ghost'}
    onClick={onToggle}
    severity={invalid ? 'danger' : 'secondary'}
    size="sm"
    type="button"
  >
    {open ? 'Skrýt podrobnosti' : 'Podrobnosti'}
  </Button>
);

export const VariantDetailEditor = ({
  disabled,
  draft,
  idPrefix,
  images,
  mainImage,
  onChange,
  productId,
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
  const tiers = variantTiersShown(draft);
  const tiersNote = tiersAtMinimumNote(draft.tiers, tiers, variantMinimumOf(draft.minimumQuantityText));
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
                appearance="ghost"
                aria-label={`Odebrat parametr ${index + 1}`}
                icon="icon-[mdi--delete-outline]"
                onClick={() =>
                  onChange({ parameters: draft.parameters.filter((entry) => entry.key !== parameter.key) })
                }
                severity="secondary"
                size="sm"
                type="button"
              />
            )}
          </div>
        ))}
        {disabled ? null : (
          <div>
            <Button
              appearance="outline"
              icon="icon-[mdi--plus]"
              onClick={() =>
                onChange({
                  parameters: [...draft.parameters, { key: nextParameterKey, label: '', unit: '', value: '' }],
                })
              }
              severity="secondary"
              size="sm"
              type="button"
            >
              Přidat parametr
            </Button>
          </div>
        )}
      </div>
      <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
        <div className="flex flex-col gap-100 sm:col-span-2">
          <h3 className="font-semibold text-sm" id={`${idPrefix}-image-label`}>
            Obrázek varianty
          </h3>
          <ul
            aria-labelledby={`${idPrefix}-image-label`}
            className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-100"
          >
            <ImageChoice
              caption="Bez obrázku"
              disabled={disabled}
              onPick={() => onChange({ imageSrc: '' })}
              selected={draft.imageSrc === ''}
            >
              <span aria-hidden className="token-icon-image-unavailable size-300 text-fg-secondary" />
            </ImageChoice>
            {imageChoices.map((image) => (
              <VariantImageTile
                disabled={disabled}
                image={image}
                key={image}
                main={image === mainImage}
                onPick={() => onChange({ imageSrc: image })}
                productId={productId}
                selected={image === draft.imageSrc}
              />
            ))}
          </ul>
          {disabled ? null : (
            <VariantPhotoUploadButton
              name={`${idPrefix}-image-upload`}
              onStored={(image) => onChange({ imageSrc: image })}
              productId={productId}
            />
          )}
        </div>
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
          onChange={(next) =>
            onChange({
              tiers: next,
              tiersEdited: true,
              tiersMinimumText:
                variantMinimumOf(draft.minimumQuantityText) === null
                  ? draft.tiersMinimumText
                  : draft.minimumQuantityText,
            })
          }
          tiers={tiers}
          vatRate={vatRate}
        />
        {tiersNote === null ? null : <p className="text-fg-secondary text-xs">{tiersNote}</p>}
        {draft.tiers.length > 0 && nextTierKey(draft.tiers) > 0 && !draft.tiersEdited && tiers === draft.tiers ? (
          <p className="text-fg-secondary text-xs">Při změně ceny varianty se množstevní ceny přepočítají.</p>
        ) : null}
      </div>
    </div>
  );
};
