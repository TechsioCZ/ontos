// Sections of the "Obsah e-shopu" tab for additional categories, homepage order, brand, SEO, documents and related
// products. They edit the tab's form; its one Uložit sends them with the rest of the content.
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { SectionCard } from '@app/admin-ui';
import { Effect } from 'effect';
import { useEffect, useState } from 'react';
import type { CategoryTrail, ProductRecord } from '../../../../../shared/apis/records.ts';
import { ProductIdSchema } from '../../../../../shared/domain/merchandise-model.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { CategorySearchCombobox } from './category-search-combobox.tsx';
import {
  contentFields,
  useUpdateAdditionalCategories,
  useUpdateContentDocuments,
  useSetRelatedProducts,
} from './product-catalog-content-form.ts';
import { documentUrlInvalid, featuredInvalid } from './product-content-extras-draft.ts';
import type { ContentExtras } from './product-content-extras-draft.ts';
import { fieldVerdict } from './product-form-validation.ts';
import { readProductLabels } from './product-reads.ts';
import { ProductSearchCombobox } from './product-search.tsx';

export interface ContentExtrasSectionsProps {
  readonly canWrite: boolean;
  /** The extra content as the tab's form has it. */
  readonly extras: ContentExtras;
  readonly hasCategoryTree: boolean;
  /** The primary category the draft has; additional ones need it. */
  readonly hasPrimaryCategory: boolean;
  readonly product: ProductRecord;
}

const moved = <T,>(items: readonly T[], index: number, offset: number): readonly T[] => {
  const target = index + offset;
  if (target < 0 || target >= items.length) {
    return items;
  }
  const next = [...items];
  const [item] = next.splice(index, 1);
  if (item !== undefined) {
    next.splice(target, 0, item);
  }
  return next;
};

const AdditionalCategories = ({ canWrite, extras, hasPrimaryCategory }: ContentExtrasSectionsProps) => {
  const setCategories = useUpdateAdditionalCategories();
  const add = (category: CategoryTrail | null) => {
    if (category !== null && !extras.additionalCategories.some((entry) => entry.id === category.id)) {
      setCategories((current) => [...current, category]);
    }
  };
  const remove = (id: string) => setCategories((current) => current.filter((entry) => entry.id !== id));
  return (
    <SectionCard title={`Další kategorie (${extras.additionalCategories.length})`}>
      {hasPrimaryCategory ? null : (
        <p className="text-fg-secondary text-sm">Další kategorie vyžadují hlavní kategorii. Nejdřív ji vyberte výše.</p>
      )}
      <ul className="flex flex-col gap-50 text-sm">
        {extras.additionalCategories.map((category) => (
          <li className="flex items-center gap-100" key={category.id}>
            <span className="min-w-0 flex-1 break-words">{category.trail}</span>
            {canWrite ? (
              <Button
                appearance="ghost"
                aria-label={`Odebrat kategorii ${category.trail}`}
                icon="icon-[mdi--delete-outline]"
                onClick={() => remove(category.id)}
                severity="secondary"
                size="sm"
                type="button"
              />
            ) : null}
          </li>
        ))}
      </ul>
      {canWrite && hasPrimaryCategory ? (
        <CategorySearchCombobox
          errorMessage="Kategorie se nepodařilo načíst."
          id="content-additional-category"
          label="Přidat další kategorii"
          loadingMessage="Načítám kategorie…"
          moreMessage={(shown, total) => `Zobrazeno ${shown} z ${total} kategorií. Upřesněte hledání.`}
          noResultsMessage="Žádná kategorie neodpovídá hledání."
          onSelect={add}
          placeholder="Hledat kategorii"
          retryLabel="Zkusit znovu"
          selected={null}
        />
      ) : null}
    </SectionCard>
  );
};

type RelatedLabel = Pick<ProductRecord, 'id' | 'name' | 'sku'>;

const NO_LABELS: readonly RelatedLabel[] = [];

/** The stored related products' labels as read; a failed read shows their ids. */
type LabelsAnswer =
  | { readonly rows: readonly RelatedLabel[]; readonly status: 'ready' }
  | { readonly cause: Effect.Error<ReturnType<typeof readProductLabels>>; readonly status: 'error' };

const relatedLabelOf = (labels: readonly RelatedLabel[], id: string) => {
  const label = labels.find((entry) => entry.id === id);
  return label === undefined ? id : `${label.name} (${label.sku})`;
};

const RelatedProducts = ({ canWrite, extras, product }: ContentExtrasSectionsProps) => {
  const [answer, setAnswer] = useState<LabelsAnswer | null>(null);
  const stored = answer?.status === 'ready' ? answer.rows : NO_LABELS;
  const [picked, setPicked] = useState<readonly RelatedLabel[]>(NO_LABELS);
  const labels = [...picked, ...stored];
  const storedKey = (product.relatedProductIds ?? []).join(',');
  useEffect(() => {
    const ids = storedKey === '' ? [] : storedKey.split(',').map((id) => ProductIdSchema.make(id));
    const fiber =
      ids.length === 0
        ? undefined
        : browserRuntime.runFork(
            readProductLabels(ids).pipe(
              Effect.match({
                onFailure: (cause): LabelsAnswer => ({ cause, status: 'error' }),
                onSuccess: (rows): LabelsAnswer => ({ rows, status: 'ready' }),
              }),
              Effect.map(setAnswer),
            ),
          );
    return () => {
      fiber?.interruptUnsafe();
    };
  }, [storedKey]);
  const update = useSetRelatedProducts();
  return (
    <SectionCard title={`Související produkty (${extras.related.length} / 12)`}>
      <ul className="flex flex-col gap-50 text-sm">
        {extras.related.map((entry, index) => (
          <li className="flex items-center gap-100" key={entry}>
            <span className="min-w-0 flex-1 break-words">{relatedLabelOf(labels, entry)}</span>
            {canWrite ? (
              <>
                <Button
                  appearance="ghost"
                  aria-label="Posunout nahoru"
                  disabled={index === 0}
                  icon="icon-[mdi--arrow-up]"
                  onClick={() => update(moved(extras.related, index, -1))}
                  severity="secondary"
                  size="sm"
                  type="button"
                />
                <Button
                  appearance="ghost"
                  aria-label="Posunout dolů"
                  disabled={index === extras.related.length - 1}
                  icon="icon-[mdi--arrow-down]"
                  onClick={() => update(moved(extras.related, index, 1))}
                  severity="secondary"
                  size="sm"
                  type="button"
                />
                <Button
                  appearance="ghost"
                  aria-label={`Odebrat ${relatedLabelOf(labels, entry)}`}
                  icon="icon-[mdi--delete-outline]"
                  onClick={() => update(extras.related.filter((other) => other !== entry))}
                  severity="secondary"
                  size="sm"
                  type="button"
                />
              </>
            ) : null}
          </li>
        ))}
      </ul>
      {canWrite && extras.related.length < 12 ? (
        <ProductSearchCombobox
          errorMessage="Produkty se nepodařilo načíst."
          id="content-related-product"
          label="Přidat související produkt"
          loadingMessage="Hledám…"
          noResultsMessage="Žádný produkt neodpovídá hledání."
          onSelect={(choice) => {
            if (choice !== null && choice.id !== product.id && !extras.related.includes(choice.id)) {
              setPicked((current) => [...current, choice]);
              update([...extras.related, choice.id]);
            }
          }}
          placeholder="Název nebo SKU"
          retryLabel="Zkusit znovu"
          selected={null}
        />
      ) : null}
    </SectionCard>
  );
};

const Documents = ({ canWrite, extras }: ContentExtrasSectionsProps) => {
  const setDocuments = useUpdateContentDocuments();
  let nextKey = 0;
  for (const document of extras.documents) {
    nextKey = Math.max(nextKey, document.key + 1);
  }
  const remove = (key: number) => setDocuments((current) => current.filter((entry) => entry.key !== key));
  return (
    <SectionCard title={`Dokumenty (${extras.documents.length})`}>
      <div className="flex flex-col gap-100">
        {extras.documents.map((document, index) => (
          <contentFields.documents.Item index={index} key={document.key}>
            <div className="grid grid-cols-1 items-end gap-100 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]">
              <contentFields.documents.label
                disabled={!canWrite}
                id={`content-document-label-${document.key}`}
                label="Název dokumentu"
                name={`content-document-label-${document.key}`}
                size="sm"
              />
              <contentFields.documents.url
                disabled={!canWrite}
                id={`content-document-url-${document.key}`}
                label="Adresa (https:// nebo /…)"
                name={`content-document-url-${document.key}`}
                size="sm"
                {...fieldVerdict(documentUrlInvalid(document.url), 'Adresa musí začínat https:// nebo /')}
              />
              {canWrite ? (
                <Button
                  appearance="ghost"
                  aria-label={`Odebrat dokument ${index + 1}`}
                  icon="icon-[mdi--delete-outline]"
                  onClick={() => remove(document.key)}
                  severity="secondary"
                  size="sm"
                  type="button"
                />
              ) : null}
            </div>
          </contentFields.documents.Item>
        ))}
      </div>
      {canWrite && extras.documents.length < 20 ? (
        <div className="mt-100">
          <Button
            appearance="outline"
            icon="icon-[mdi--plus]"
            onClick={() => setDocuments((current) => [...current, { key: nextKey, label: '', url: '' }])}
            severity="secondary"
            size="sm"
            type="button"
          >
            Přidat dokument
          </Button>
        </div>
      ) : null}
    </SectionCard>
  );
};

/** Additional categories, homepage order, brand, SEO, documents and related products. */
export const ContentExtrasSections = (props: ContentExtrasSectionsProps) => {
  const { canWrite, extras, hasCategoryTree, product } = props;
  return (
    <>
      {hasCategoryTree ? <AdditionalCategories {...props} /> : null}
      <SectionCard title="Úvodní stránka a značka">
        <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
          <contentFields.featuredText
            disabled={!canWrite}
            helpText="Prázdné = produkt není na úvodní stránce. Menší číslo je dřív."
            id="content-featured-position"
            inputMode="decimal"
            label="Pořadí na úvodní stránce"
            name="featuredPosition"
            {...fieldVerdict(featuredInvalid(extras.featuredText), 'Zadejte číslo')}
          />
          <contentFields.brand
            disabled={!canWrite}
            id="content-brand"
            label="Značka (výrobce)"
            maxLength={120}
            name="brand"
          />
        </div>
      </SectionCard>
      <SectionCard title="SEO">
        <div className="flex flex-col gap-200">
          <contentFields.seoTitle
            disabled={!canWrite}
            helpText={`${extras.seoTitle.trim().length} / 200 znaků. Prázdné = název produktu.`}
            id="content-seo-title"
            label="SEO titulek"
            maxLength={200}
            name="seoTitle"
            placeholder={product.name}
          />
          <contentFields.seoDescription
            disabled={!canWrite}
            helpText={`${extras.seoDescription.trim().length} / 500 znaků. Prázdné = krátký popis.`}
            id="content-seo-description"
            label="SEO popis"
            maxLength={500}
            name="seoDescription"
            placeholder={product.shortDescription ?? ''}
          />
        </div>
      </SectionCard>
      <Documents {...props} />
      <RelatedProducts {...props} />
    </>
  );
};

export const ContentExtrasError = ({ invalid }: { readonly invalid: boolean }) =>
  invalid ? (
    <StatusText showIcon status="error">
      Opravte zvýrazněné údaje (dokumenty potřebují název a adresu https:// nebo /).
    </StatusText>
  ) : null;
