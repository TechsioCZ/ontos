import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
// Storefront content of one product: category, labels, parameters, main image alt text and its change history.
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Switch } from '@techsio/ui-kit/molecules/switch';
import { Table } from '@techsio/ui-kit/organisms/table';
import { formatDateTime, ScrollRegion, SectionCard } from '@app/admin-ui';
import { DateTime } from 'effect';
import { useRef, useState } from 'react';
import type { ProductPatch } from '../../../../../shared/actions/apply-command.ts';
import type { CategoryTrail, ProductRecord } from '../../../../../shared/apis/records.ts';
import { CategorySearchCombobox } from './category-search-combobox.tsx';
import { ProductTabSaveBar, useProductTabSave } from './product-tab-save.tsx';

export interface CatalogContentPanelProps {
  /** The editor shows this tab; the form's Save button is rendered only then. */
  readonly active?: boolean;
  readonly canWrite: boolean;
  /** The product's tree category with its path label; null when it has none. */
  readonly category: CategoryTrail | null;
  /** The company has a storefront category tree. */
  readonly hasCategoryTree: boolean;
  readonly onCommitted: (message: string) => void;
  readonly onReload: () => void;
  readonly product: ProductRecord;
  readonly revision: number;
}

interface ParameterDraft {
  readonly key: number;
  readonly label: string;
  readonly unit: string;
  readonly value: string;
}

interface Flags {
  readonly isAction: boolean;
  readonly isNew: boolean;
  readonly isRecommended: boolean;
  readonly isSale: boolean;
}

/** The content form's draft. `category` is the tree category picked here; `keep` keeps the product's own. */
interface ContentDraft {
  readonly category: CategoryTrail | null | 'keep';
  readonly flags: Flags;
  readonly imageAlt: string;
  readonly parameters: readonly ParameterDraft[];
}

const contentDraftOf = (product: ProductRecord): ContentDraft => ({
  category: 'keep',
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
  parameters.some((parameter) => parameter.label.trim() === '' || parameter.value.trim() === '');

/** The UpdateProduct patch of a content draft. */
const contentPatchOf = (draft: ContentDraft, category: CategoryTrail | null, product: ProductRecord): ProductPatch => {
  const picked = draft.category === 'keep' ? category : draft.category;
  const categoryId = picked?.id ?? product.categoryId;
  const patch: { -readonly [Key in keyof ProductPatch]: ProductPatch[Key] } = {};
  if (categoryId !== undefined && categoryId !== product.categoryId) {
    patch.categoryId = categoryId;
  }
  patch.parameters = draft.parameters.map(({ label, unit, value }) => ({
    label: label.trim(),
    unit: unit.trim(),
    value: value.trim(),
  }));
  patch.isAction = draft.flags.isAction;
  patch.isNew = draft.flags.isNew;
  patch.isRecommended = draft.flags.isRecommended;
  patch.isSale = draft.flags.isSale;
  patch.imageAlt = draft.imageAlt.trim();
  return patch;
};

/**
 * Storefront content of one product. Editing changes the draft only; the Save button under the form sends it as one
 * UpdateProduct, and leaving with unsaved changes asks first.
 */
export const CatalogContentPanel = ({
  active = true,
  canWrite,
  category,
  hasCategoryTree,
  onCommitted,
  onReload,
  product,
  revision,
}: CatalogContentPanelProps) => {
  const { t } = useModernI18n();
  const [form, setForm] = useState<ContentDraft>(() => contentDraftOf(product));
  const picked = form.category === 'keep' ? category : form.category;
  const { flags, imageAlt, parameters } = form;
  const nextKey = useRef((product.parameters ?? []).length);
  const setCategoryDraft = (next: CategoryTrail | null) => setForm((current) => ({ ...current, category: next }));
  const setFlags = (update: (current: Flags) => Flags) =>
    setForm((current) => ({ ...current, flags: update(current.flags) }));
  const setImageAlt = (next: string) => setForm((current) => ({ ...current, imageAlt: next }));
  const setParameters = (update: (current: readonly ParameterDraft[]) => readonly ParameterDraft[]) =>
    setForm((current) => ({ ...current, parameters: update(current.parameters) }));
  const save = useProductTabSave<ContentDraft>({
    commandOf: (value) => ({ _tag: 'UpdateProduct', id: product.id, patch: contentPatchOf(value, category, product) }),
    isValid: (value) => !parametersInvalidOf(value.parameters),
    onReload,
    onSaved: () => onCommitted('Obsah e-shopu uložen. Změnu uvidí zákazník po obnovení stránky.'),
    reset: (next) => {
      setForm(next);
      nextKey.current = Math.max(nextKey.current, next.parameters.length);
    },
    revision,
    server: contentDraftOf(product),
    value: form,
  });

  const parametersInvalid = parametersInvalidOf(parameters);

  const removeParameter = (key: number) => setParameters((current) => current.filter((entry) => entry.key !== key));

  const patchParameter = (key: number, next: Partial<ParameterDraft>) =>
    setParameters((current) =>
      current.map((parameter) => (parameter.key === key ? { ...parameter, ...next } : parameter)),
    );

  const history = (product.contentHistory ?? []).toReversed();

  return (
    <div className="flex flex-col gap-250">
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
          <Switch
            checked={flags.isAction}
            disabled={!canWrite}
            name="label-isAction"
            onCheckedChange={(checked: boolean) => setFlags((current) => ({ ...current, isAction: checked }))}
          >
            Akce
          </Switch>
          <Switch
            checked={flags.isNew}
            disabled={!canWrite}
            name="label-isNew"
            onCheckedChange={(checked: boolean) => setFlags((current) => ({ ...current, isNew: checked }))}
          >
            Novinka
          </Switch>
          <Switch
            checked={flags.isRecommended}
            disabled={!canWrite}
            name="label-isRecommended"
            onCheckedChange={(checked: boolean) => setFlags((current) => ({ ...current, isRecommended: checked }))}
          >
            Doporučujeme
          </Switch>
          <Switch
            checked={flags.isSale}
            disabled={!canWrite}
            name="label-isSale"
            onCheckedChange={(checked: boolean) => setFlags((current) => ({ ...current, isSale: checked }))}
          >
            Výprodej
          </Switch>
        </div>
      </SectionCard>

      <SectionCard title={`Parametry (${parameters.length})`}>
        {parameters.length === 0 ? (
          <p className="text-fg-secondary text-sm">Produkt nemá žádné parametry.</p>
        ) : (
          <div className="flex flex-col gap-100">
            {parameters.map((parameter, index) => (
              <div
                className="grid grid-cols-1 items-end gap-100 sm:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_minmax(0,1fr)_auto]"
                key={parameter.key}
              >
                <FormInput
                  disabled={!canWrite}
                  id={`parameter-label-${parameter.key}`}
                  label={t('merchandise.ui.parameterName')}
                  name={`parameter-label-${parameter.key}`}
                  onChange={(event) => patchParameter(parameter.key, { label: event.target.value })}
                  size="sm"
                  value={parameter.label}
                />
                <FormInput
                  disabled={!canWrite}
                  id={`parameter-value-${parameter.key}`}
                  label={t('merchandise.ui.value')}
                  name={`parameter-value-${parameter.key}`}
                  onChange={(event) => patchParameter(parameter.key, { value: event.target.value })}
                  size="sm"
                  value={parameter.value}
                />
                <FormInput
                  disabled={!canWrite}
                  id={`parameter-unit-${parameter.key}`}
                  label={t('merchandise.ui.unit')}
                  name={`parameter-unit-${parameter.key}`}
                  onChange={(event) => patchParameter(parameter.key, { unit: event.target.value })}
                  size="sm"
                  value={parameter.unit}
                />
                {canWrite ? (
                  <Button
                    aria-label={`Odebrat parametr ${index + 1}`}
                    icon="icon-[mdi--delete-outline]"
                    onClick={() => removeParameter(parameter.key)}
                    size="sm"
                    theme="borderless"
                    type="button"
                    variant="secondary"
                  />
                ) : null}
              </div>
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
              icon="icon-[mdi--plus]"
              onClick={() => {
                const key = nextKey.current;
                nextKey.current += 1;
                setParameters((current) => [...current, { key, label: '', unit: '', value: '' }]);
              }}
              size="sm"
              theme="outlined"
              type="button"
              variant="secondary"
            >
              Přidat parametr
            </Button>
          </div>
        ) : null}
      </SectionCard>

      <SectionCard title={t('merchandise.ui.mainImage')}>
        <FormInput
          disabled={!canWrite}
          id="content-image-alt"
          label={t('merchandise.ui.mainImageAlt')}
          name="imageAlt"
          onChange={(event) => setImageAlt(event.target.value)}
          value={imageAlt}
        />
        <p className="mt-100 text-fg-secondary text-sm">
          Obrázky přidáte nebo odeberete na kartě E-shop a obrázky; název a popisy na kartě Detail.
        </p>
      </SectionCard>

      {canWrite ? <ProductTabSaveBar active={active} save={save} /> : null}

      <SectionCard title={t('merchandise.ui.contentChangeHistory')}>
        {history.length === 0 ? (
          <p className="text-fg-secondary text-sm">Zatím žádné změny obsahu.</p>
        ) : (
          <ScrollRegion label={t('merchandise.ui.contentChangeHistory')}>
            <Table size="sm" variant="line">
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
    </div>
  );
};
