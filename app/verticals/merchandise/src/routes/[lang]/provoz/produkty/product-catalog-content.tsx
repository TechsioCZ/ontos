import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
// Storefront content of one product: category, labels, parameters, main image alt text and its change history.
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Table } from '@techsio/ui-kit/organisms/table';
import { formatDateTime, ScrollRegion, SectionCard } from '@app/admin-ui';
import { useAtomValue } from '@app/core-runtime/ui/form';
import { DateTime, Option } from 'effect';
import { useRef } from 'react';
import type { ProductPatch } from '../../../../../shared/actions/apply-command.ts';
import type { CategoryTrail, ProductRecord } from '../../../../../shared/apis/records.ts';
import { CategorySearchCombobox } from './category-search-combobox.tsx';
import { ProductTabSaveBar, useProductTabSave } from './product-tab-save.tsx';
import { productVersionOf } from './products-api.ts';
import { ContentExtrasError, ContentExtrasSections } from './product-content-extras.tsx';
import { addContentExtrasPatch, contentExtrasInvalid, contentExtrasOf } from './product-content-extras-draft.ts';
import {
  ContentForm,
  contentDraft,
  contentFields,
  useSetContentCategory,
  useUpdateContentParameters,
  useSetContentDraft,
} from './product-catalog-content-form.ts';
import type { ContentDraft, ParameterDraft } from './product-catalog-content-form.ts';

export interface CatalogContentPanelProps {
  /** The editor shows this tab; the form's Save button is rendered only then. */
  readonly active?: boolean;
  readonly canWrite: boolean;
  /** The product's tree category with its path label; null when it has none. */
  readonly category: CategoryTrail | null;
  /** Path labels of the product's categories (additional ones included). */
  readonly categoryTrails?: readonly CategoryTrail[];
  /** The company has a storefront category tree. */
  readonly hasCategoryTree: boolean;
  readonly onCommitted: (message: string) => void;
  readonly onReload: () => void;
  readonly product: ProductRecord;
  readonly revision: number;
}

/** No category paths: the product has none besides its own. */
const NO_TRAILS: readonly CategoryTrail[] = [];

const contentDraftOf = (product: ProductRecord, trails: readonly CategoryTrail[] = []): ContentDraft => ({
  category: 'keep',
  extras: contentExtrasOf(product, trails),
  flags: {
    isAction: product.isAction === true,
    isNew: product.isNew === true,
    isRecommended: product.isRecommended === true,
    isSale: product.isSale === true,
  },
  imageAlt: product.imageAlt ?? '',
  parameters: (product.parameters ?? []).map((parameter, index) => ({
    key: index,
    label: parameter.label,
    unit: parameter.unit,
    value: parameter.value,
  })),
});

const parametersInvalidOf = (parameters: readonly ParameterDraft[]) =>
  parameters.some((parameter) => parameter.label.trim() === '' && parameter.value.trim() !== '');

/** The UpdateProduct patch of a content draft. */
const contentPatchOf = (draft: ContentDraft, product: ProductRecord): ProductPatch => {
  // 'keep' never touches the category: re-linking a free-text category to its tree match would rename it.
  const categoryId = draft.category === 'keep' ? product.categoryId : (draft.category?.id ?? product.categoryId);
  const patch: { -readonly [Key in keyof ProductPatch]: ProductPatch[Key] } = {};
  if (categoryId !== undefined && categoryId !== product.categoryId) {
    patch.categoryId = categoryId;
  }
  patch.parameters = draft.parameters.flatMap(({ label, unit, value }) =>
    label.trim() === '' ? [] : [{ label: label.trim(), unit: unit.trim(), value: value.trim() }],
  );
  patch.isAction = draft.flags.isAction;
  patch.isNew = draft.flags.isNew;
  patch.isRecommended = draft.flags.isRecommended;
  patch.isSale = draft.flags.isSale;
  patch.imageAlt = draft.imageAlt.trim();
  addContentExtrasPatch(patch, draft.extras, product);
  return patch;
};

const labelFields = [
  ['isAction', 'Akce', contentFields.isAction],
  ['isNew', 'Novinka', contentFields.isNew],
  ['isRecommended', 'Doporučujeme', contentFields.isRecommended],
  ['isSale', 'Výprodej', contentFields.isSale],
] as const;

/** The product's parameters: a row of name, value and unit each, added and removed here. */
const ParameterRows = ({
  canWrite,
  onAdd,
  parameters,
}: {
  readonly canWrite: boolean;
  /** Adds an empty row. */
  readonly onAdd: () => void;
  readonly parameters: readonly ParameterDraft[];
}) => {
  const { t } = useModernI18n();
  const setParameters = useUpdateContentParameters();
  const removeParameter = (key: number) => setParameters((current) => current.filter((entry) => entry.key !== key));
  const parametersInvalid = parametersInvalidOf(parameters);
  return (
    <SectionCard title={`Parametry (${parameters.length})`}>
      {parameters.length === 0 ? (
        <p className="text-fg-secondary text-sm">Produkt nemá žádné parametry.</p>
      ) : (
        <div className="flex flex-col gap-100">
          {parameters.map((parameter, index) => (
            <contentFields.parameters.Item index={index} key={parameter.key}>
              <div className="grid grid-cols-1 items-end gap-100 sm:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_minmax(0,1fr)_auto]">
                <contentFields.parameters.label
                  disabled={!canWrite}
                  id={`parameter-label-${parameter.key}`}
                  label={t('merchandise.ui.parameterName')}
                  name={`parameter-label-${parameter.key}`}
                  size="sm"
                />
                <contentFields.parameters.value
                  disabled={!canWrite}
                  id={`parameter-value-${parameter.key}`}
                  label={t('merchandise.ui.value')}
                  name={`parameter-value-${parameter.key}`}
                  size="sm"
                />
                <contentFields.parameters.unit
                  disabled={!canWrite}
                  id={`parameter-unit-${parameter.key}`}
                  label={t('merchandise.ui.unit')}
                  name={`parameter-unit-${parameter.key}`}
                  size="sm"
                />
                {canWrite ? (
                  <Button
                    appearance="ghost"
                    aria-label={`Odebrat parametr ${index + 1}`}
                    icon="icon-[mdi--delete-outline]"
                    onClick={() => removeParameter(parameter.key)}
                    severity="secondary"
                    size="sm"
                    type="button"
                  />
                ) : null}
              </div>
            </contentFields.parameters.Item>
          ))}
        </div>
      )}
      {parametersInvalid ? (
        <StatusText showIcon status="error">
          Vyplňte název i hodnotu každého parametru.
        </StatusText>
      ) : null}
      {canWrite ? (
        <div className="mt-100">
          <Button
            appearance="outline"
            icon="icon-[mdi--plus]"
            onClick={onAdd}
            severity="secondary"
            size="sm"
            type="button"
          >
            Přidat parametr
          </Button>
        </div>
      ) : null}
    </SectionCard>
  );
};

const ContentHistory = ({ product }: { readonly product: ProductRecord }) => {
  const { t } = useModernI18n();
  const history = (product.contentHistory ?? []).toReversed();
  return (
    <SectionCard title={t('merchandise.ui.contentChangeHistory')}>
      {history.length === 0 ? (
        <p className="text-fg-secondary text-sm">Zatím žádné změny obsahu.</p>
      ) : (
        <ScrollRegion label={t('merchandise.ui.contentChangeHistory')}>
          <Table appearance="line" size="sm">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>Kdy</Table.ColumnHeader>
                <Table.ColumnHeader>Co se změnilo</Table.ColumnHeader>
                <Table.ColumnHeader>Původně</Table.ColumnHeader>
                <Table.ColumnHeader>Nově</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {history.map((entry, index) => (
                <Table.Row key={`${DateTime.formatIso(entry.at)}-${index}`}>
                  <Table.Cell>{formatDateTime(DateTime.formatIso(entry.at))}</Table.Cell>
                  <Table.Cell>{entry.fields.join(', ')}</Table.Cell>
                  <Table.Cell className="max-w-80 break-words text-fg-secondary">{entry.before}</Table.Cell>
                  <Table.Cell className="max-w-80 break-words">{entry.after}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </ScrollRegion>
      )}
    </SectionCard>
  );
};

const CatalogContentFields = ({
  active = true,
  canWrite,
  category,
  categoryTrails = NO_TRAILS,
  hasCategoryTree,
  onCommitted,
  onReload,
  product,
  revision,
}: CatalogContentPanelProps) => {
  const { t } = useModernI18n();
  const form = Option.getOrElse(useAtomValue(contentDraft), () => contentDraftOf(product, categoryTrails));
  const setDraft = useSetContentDraft();
  const setCategoryDraft = useSetContentCategory();
  const setParameters = useUpdateContentParameters();
  const picked = form.category === 'keep' ? category : form.category;
  const nextKey = useRef((product.parameters ?? []).length);
  const save = useProductTabSave<ContentDraft>({
    commandOf: (value) => ({ _tag: 'UpdateProduct', id: product.id, patch: contentPatchOf(value, product) }),
    isValid: (value) => !parametersInvalidOf(value.parameters) && !contentExtrasInvalid(value.extras),
    keepAs: `content:${product.id}`,
    onReload,
    onSaved: () => onCommitted('Obsah e-shopu uložen. Změnu uvidí zákazník po obnovení stránky.'),
    reset: (next) => {
      setDraft(next);
      nextKey.current = Math.max(nextKey.current, next.parameters.length);
    },
    revision,
    server: contentDraftOf(product, categoryTrails),
    value: form,
    version: productVersionOf(product),
  });

  return (
    <>
      <SectionCard title={t('merchandise.ui.storefrontCategory')}>
        {hasCategoryTree ? (
          <>
            <p className="text-sm">
              Aktuální kategorie: <strong>{picked?.trail ?? '—'}</strong>
            </p>
            {canWrite ? (
              <CategorySearchCombobox
                errorMessage="Kategorie se nepodařilo načíst."
                id="content-category-search"
                label={t('merchandise.ui.searchCategories')}
                loadingMessage="Načítám kategorie…"
                moreMessage={(shown, total) =>
                  `Zobrazeno ${shown} z ${total} kategorií. Upřesněte hledání, např. názvem nadřazené kategorie.`
                }
                noResultsMessage="Žádná kategorie neodpovídá hledání."
                onSelect={setCategoryDraft}
                placeholder={t('merchandise.ui.categoryPathPlaceholder')}
                retryLabel="Zkusit znovu"
                selected={picked}
              />
            ) : null}
          </>
        ) : (
          <p className="text-fg-secondary text-sm">
            Tato firma nemá strom kategorií e-shopu. Název kategorie upravíte na kartě Detail.
          </p>
        )}
      </SectionCard>

      <SectionCard title={t('merchandise.ui.storefrontLabels')}>
        <div className="flex flex-wrap gap-200">
          {labelFields.map(([flag, label, LabelField]) => (
            <LabelField disabled={!canWrite} key={flag} name={`label-${flag}`}>
              {label}
            </LabelField>
          ))}
        </div>
      </SectionCard>

      <ParameterRows
        canWrite={canWrite}
        onAdd={() => {
          const key = nextKey.current;
          nextKey.current += 1;
          setParameters((current) => [...current, { key, label: '', unit: '', value: '' }]);
        }}
        parameters={form.parameters}
      />

      <SectionCard title={t('merchandise.ui.mainImage')}>
        <contentFields.imageAlt
          disabled={!canWrite}
          id="content-image-alt"
          label={t('merchandise.ui.mainImageAlt')}
          name="imageAlt"
        />
        <p className="mt-100 text-fg-secondary text-sm">
          Obrázky přidáte nebo odeberete na kartě E-shop a obrázky; název a popisy na kartě Detail.
        </p>
      </SectionCard>

      <ContentExtrasSections
        canWrite={canWrite}
        extras={form.extras}
        hasCategoryTree={hasCategoryTree}
        hasPrimaryCategory={(picked?.id ?? product.categoryId) !== undefined}
        product={product}
      />
      <ContentExtrasError invalid={contentExtrasInvalid(form.extras)} />

      {canWrite ? <ProductTabSaveBar active={active} save={save} /> : null}

      <ContentHistory product={product} />
    </>
  );
};

/**
 * Storefront content of one product. Editing changes the form only; the Save button under the form sends it as one
 * UpdateProduct, and leaving with unsaved changes asks first.
 */
export const CatalogContentPanel = (props: CatalogContentPanelProps) => (
  <ContentForm className="flex flex-col gap-250" draft={contentDraftOf(props.product, props.categoryTrails)}>
    <CatalogContentFields {...props} />
  </ContentForm>
);
