// Edit dialog of one Catalog product on the staff product list (Novinky z ERP): text, lifecycle, Categories and
// Variants (name, SKU, retire/reactivate). Each change is sent to Catalog's own Action; the list reloads afterwards.
import { Button } from '@techsio/ui-kit/atoms/button';
import { Input } from '@techsio/ui-kit/atoms/input';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { Effect, Option, Schema } from 'effect';
import { useState } from 'react';

import { AddProductCategoryAssignmentPayloadSchema } from '../../shared/actions/add-product-category-assignment.ts';
import { AssignSkuPayloadSchema } from '../../shared/actions/assign-sku.ts';
import { ConfirmVariantCombinationPayloadSchema } from '../../shared/actions/confirm-variant-combination.ts';
import { GovernVariantAxesPayloadSchema } from '../../shared/actions/govern-variant-axes.ts';
import {
  CreateProductCategoryPayloadSchema,
  CreateProductCategoryResultSchema,
} from '../../shared/actions/create-product-category.ts';
import {
  SetProductLocalizedFactsPayloadSchema,
  SetVariantLocalizedFactsPayloadSchema,
} from '../../shared/actions/localized-facts.ts';
import { ReactivateProductPayloadSchema } from '../../shared/actions/reactivate-product.ts';
import { ReactivateVariantPayloadSchema } from '../../shared/actions/reactivate-variant.ts';
import { RemoveProductCategoryAssignmentPayloadSchema } from '../../shared/actions/remove-product-category-assignment.ts';
import { RenameSkuPayloadSchema } from '../../shared/actions/rename-sku.ts';
import { RetireProductPayloadSchema } from '../../shared/actions/retire-product.ts';
import { RetireVariantPayloadSchema } from '../../shared/actions/retire-variant.ts';
import { UpdateProductPayloadSchema } from '../../shared/actions/update-product.ts';
import type { ProductPageItem } from '../../shared/apis/product-page.ts';
import { erpStorefrontStatus } from './erp-storefront-status.ts';
import { executeAddProductCategoryAssignment } from '../api/add-product-category-assignment-action-client.ts';
import { executeAssignSku } from '../api/assign-sku-action-client.ts';
import { executeConfirmVariantCombination } from '../api/confirm-variant-combination-action-client.ts';
import { executeGovernVariantAxes } from '../api/govern-variant-axes-action-client.ts';
import { executeCreateProductCategory } from '../api/create-product-category-action-client.ts';
import { executeReactivateProduct } from '../api/reactivate-product-action-client.ts';
import { executeReactivateVariant } from '../api/reactivate-variant-action-client.ts';
import { executeRemoveProductCategoryAssignment } from '../api/remove-product-category-assignment-action-client.ts';
import { executeRenameSku } from '../api/rename-sku-action-client.ts';
import { executeRetireProduct } from '../api/retire-product-action-client.ts';
import { executeRetireVariant } from '../api/retire-variant-action-client.ts';
import { executeSetProductLocalizedFacts } from '../api/set-product-localized-facts-action-client.ts';
import { executeSetVariantLocalizedFacts } from '../api/set-variant-localized-facts-action-client.ts';
import { executeUpdateProduct } from '../api/update-product-action-client.ts';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import { requestId } from './browser-crypto.ts';
import { ErpMediaSection } from './erp-media-section.tsx';
import { productListData, variantFiguresData } from './page-data.ts';

type Lifecycle = ProductPageItem['lifecycle'];
type CategoryName = ProductPageItem['categories'][number];

interface VariantDraft {
  readonly name: string;
  readonly retired: boolean;
  readonly sku: string;
}

interface Draft {
  readonly categoryIds: readonly string[];
  readonly description: string;
  readonly lifecycle: Lifecycle;
  readonly name: string;
  readonly reason: string;
  readonly variants: Readonly<Record<string, VariantDraft>>;
}

const evidence = 'admin:catalog-products-edit';

const presentText = (localized: ProductPageItem['localized']) =>
  localized.kind === 'PRESENT'
    ? { description: localized.description ?? '', name: localized.name }
    : { description: '', name: '' };

const draftOf = (item: ProductPageItem): Draft => ({
  categoryIds: item.categories.map(({ categoryRef }) => categoryRef.resourceId),
  ...presentText(item.localized),
  lifecycle: item.lifecycle,
  reason: 'Úprava produktu v administraci',
  variants: Object.fromEntries(
    item.variants.map((variant) => [
      variant.variantRef.resourceId,
      { name: presentText(variant.localized).name, retired: variant.lifecycle === 'RETIRED', sku: variant.sku ?? '' },
    ]),
  ),
});

/** Every generated Action problem and a schema error carry a tag naming what went wrong. */
interface Problem {
  readonly _tag: string;
}

const describe = (step: string, problem: Problem): string => `${step}: ${problem._tag}`;

type Execute<P> = (
  payload: P,
  requestCorrelation: string,
  options: { readonly idempotencyKey: string },
) => Effect.Effect<unknown, Problem>;

/** Decodes the payload with the Action's own schema and sends it with a fresh idempotency key. */
const send = <P, I>(step: string, schema: Schema.Codec<P, I>, encoded: I, execute: Execute<P>) =>
  Schema.decodeEffect(schema)(encoded).pipe(
    Effect.flatMap((payload) => requestId.pipe(Effect.flatMap((id) => execute(payload, id, { idempotencyKey: id })))),
    Effect.mapError((problem) => describe(step, problem)),
  );

/**
 * Catalog activates a Product only with an ACTIVE Variant, and a Variant becomes ACTIVE only by confirming its
 * combination against the Product's axis basis. An ERP draft has no basis yet: initialize it axis-free (a basis that
 * already exists answers a revision conflict, which is fine), then confirm every work-in-progress Variant at revision 1.
 */
const activationSteps = (item: ProductPageItem, draft: Draft) => {
  const pending = item.variants.filter(
    (variant) =>
      variant.lifecycle === 'WORK_IN_PROGRESS' && draft.variants[variant.variantRef.resourceId]?.retired !== true,
  );
  if (pending.length === 0) {
    return [];
  }
  const basis = send(
    'Osy variant',
    GovernVariantAxesPayloadSchema,
    {
      axes: [],
      classification: { evidenceRefs: [evidence], kind: 'AXIS_INITIALIZATION', reason: draft.reason },
      expectedAxisRevision: 0,
      productRef: item.productRef,
      reason: draft.reason,
    },
    executeGovernVariantAxes,
  ).pipe(Effect.ignore);
  return [
    basis,
    ...pending.map((variant) =>
      send(
        `Aktivace varianty ${variant.sku ?? variant.variantRef.resourceId.slice(0, 8)}`,
        ConfirmVariantCombinationPayloadSchema,
        {
          evidenceRefs: [evidence],
          expectedAxisRevision: 1,
          expectedVariantRevision: variant.revision ?? 1,
          productRef: item.productRef,
          reason: draft.reason,
          variantRef: variant.variantRef,
        },
        executeConfirmVariantCombination,
      ),
    ),
  ];
};

const lifecycleStep = (item: ProductPageItem, draft: Draft) => {
  if (draft.lifecycle === item.lifecycle) {
    return [];
  }
  const base = { expectedRevision: item.revision, productRef: item.productRef, reason: draft.reason };
  if (item.lifecycle === 'RETIRED') {
    return [send('Obnovení produktu', ReactivateProductPayloadSchema, base, executeReactivateProduct)];
  }
  if (draft.lifecycle === 'RETIRED') {
    return [send('Vyřazení produktu', RetireProductPayloadSchema, base, executeRetireProduct)];
  }
  return [
    ...(draft.lifecycle === 'ACTIVE' ? activationSteps(item, draft) : []),
    send(
      'Stav produktu',
      UpdateProductPayloadSchema,
      { ...base, targetLifecycle: draft.lifecycle },
      executeUpdateProduct,
    ),
  ];
};

const variantSteps = (item: ProductPageItem, draft: Draft, locale: string) =>
  item.variants.flatMap((variant) => {
    const next = draft.variants[variant.variantRef.resourceId];
    if (next === undefined) {
      return [];
    }
    const label = variant.sku ?? variant.variantRef.resourceId.slice(0, 8);
    const steps = [];
    const name = next.name.trim();
    if (name !== '' && name !== presentText(variant.localized).name) {
      steps.push(
        send(
          `Název varianty ${label}`,
          SetVariantLocalizedFactsPayloadSchema,
          {
            evidenceRefs: [],
            expectedRevision: variant.localizedRevision ?? 0,
            facts: { name },
            locale,
            productRef: item.productRef,
            reason: draft.reason,
            variantRef: variant.variantRef,
          },
          executeSetVariantLocalizedFacts,
        ),
      );
    }
    const sku = next.sku.trim();
    const target = {
      kind: 'VARIANT' as const,
      tenantId: variant.variantRef.tenantId,
      variantId: variant.variantRef.resourceId,
    };
    if (sku !== '' && variant.sku === undefined) {
      steps.push(
        send(
          `SKU varianty ${label}`,
          AssignSkuPayloadSchema,
          { code: sku, evidenceRefs: [evidence], expectedRevision: 0, reason: draft.reason, target },
          executeAssignSku,
        ),
      );
    }
    if (sku !== '' && variant.sku !== undefined && sku !== variant.sku) {
      steps.push(
        send(
          `SKU varianty ${label}`,
          RenameSkuPayloadSchema,
          {
            code: sku,
            evidenceRefs: [evidence],
            expectedRevision: variant.skuRevision ?? 1,
            oldCode: variant.sku,
            reason: draft.reason,
            target,
          },
          executeRenameSku,
        ),
      );
    }
    const retired = variant.lifecycle === 'RETIRED';
    const lifecycle = {
      expectedVariantRevision: variant.revision ?? 1,
      reason: draft.reason,
      variantRef: variant.variantRef,
    };
    if (next.retired && !retired) {
      steps.push(send(`Vyřazení varianty ${label}`, RetireVariantPayloadSchema, lifecycle, executeRetireVariant));
    }
    if (!next.retired && retired) {
      steps.push(
        send(
          `Obnovení varianty ${label}`,
          ReactivateVariantPayloadSchema,
          { ...lifecycle, evidenceRefs: [evidence] },
          executeReactivateVariant,
        ),
      );
    }
    return steps;
  });

/** Every Action the draft needs, in the order Catalog admits them: text before activation. */
const saveSteps = (item: ProductPageItem, draft: Draft, locale: string, known: readonly CategoryName[]) => {
  const current = presentText(item.localized);
  const name = draft.name.trim();
  const description = draft.description.trim();
  const textSteps =
    name !== '' && (name !== current.name || description !== current.description)
      ? [
          send(
            'Název a popis',
            SetProductLocalizedFactsPayloadSchema,
            {
              evidenceRefs: [],
              expectedRevision: item.localizedRevision ?? 0,
              facts: description === '' ? { name } : { description, name },
              locale,
              productRef: item.productRef,
              reason: draft.reason,
            },
            executeSetProductLocalizedFacts,
          ),
        ]
      : [];
  const before = new Set(item.categories.map(({ categoryRef }) => categoryRef.resourceId));
  const after = new Set(draft.categoryIds);
  const refOf = (id: string) =>
    known.find(({ categoryRef }) => categoryRef.resourceId === id)?.categoryRef ?? {
      moduleId: item.productRef.moduleId,
      resourceId: id,
      resourceType: 'commerce.catalog.product-category',
      tenantId: item.productRef.tenantId,
    };
  const categoryReason = draft.reason;
  const categoryStep = (id: string, adding: boolean) =>
    adding
      ? send(
          'Přidání kategorie',
          AddProductCategoryAssignmentPayloadSchema,
          { categoryRef: refOf(id), productRef: item.productRef, reason: categoryReason },
          executeAddProductCategoryAssignment,
        )
      : send(
          'Odebrání kategorie',
          RemoveProductCategoryAssignmentPayloadSchema,
          { categoryRef: refOf(id), productRef: item.productRef, reason: categoryReason },
          executeRemoveProductCategoryAssignment,
        );
  const categorySteps = [
    ...[...after].flatMap((id) => (before.has(id) ? [] : [categoryStep(id, true)])),
    ...[...before].flatMap((id) => (after.has(id) ? [] : [categoryStep(id, false)])),
  ];
  return [...textSteps, ...categorySteps, ...variantSteps(item, draft, locale), ...lifecycleStep(item, draft)];
};

const fieldClass = 'w-full rounded-md border border-border-primary bg-base px-150 py-100 text-sm';

interface ProductEditDialogProps {
  /** Categories the page knows by name (this product's and the other listed products'). */
  readonly categories: readonly CategoryName[];
  readonly item: ProductPageItem;
  /** The signed-in company, whose e-shop the storefront status is for. */
  readonly legalEntityId?: string;
  /** The locale the list reads, so the text revision the dialog sends matches. */
  readonly locale: string;
  readonly onClose: () => void;
}

export const ProductEditDialog = ({
  categories,
  item,
  legalEntityId = '',
  locale,
  onClose,
}: ProductEditDialogProps) => {
  const [draft, setDraft] = useState<Draft>(() => draftOf(item));
  const [newCategory, setNewCategory] = useState('');
  const [createdCategories, setCreatedCategories] = useState<readonly CategoryName[]>([]);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const updateVariant = (id: string, patch: Partial<VariantDraft>) =>
    setDraft((current) => {
      const previous = current.variants[id];
      return previous === undefined
        ? current
        : { ...current, variants: { ...current.variants, [id]: { ...previous, ...patch } } };
    });
  const toggleCategory = (id: string, on: boolean) =>
    update({ categoryIds: on ? [...new Set([...draft.categoryIds, id])] : draft.categoryIds.filter((x) => x !== id) });
  const finish = (message: string | null) => {
    productListData.invalidate();
    variantFiguresData.invalidate();
    setBusy(false);
    if (message === null) {
      onClose();
      return;
    }
    setFailure(`Uložení se nezdařilo – ${message}. Ostatní změny před touto chybou byly uloženy.`);
  };
  const save = () => {
    if (draft.reason.trim() === '') {
      setFailure('Vyplňte důvod změny.');
      return;
    }
    if (draft.name.trim() === '' && item.localized.kind === 'PRESENT') {
      setFailure('Název nesmí být prázdný.');
      return;
    }
    setBusy(true);
    setFailure(null);
    const steps = saveSteps(item, { ...draft, reason: draft.reason.trim() }, locale, [
      ...categories,
      ...createdCategories,
    ]);
    browserRuntime.runFork(
      Effect.forEach(steps, (step) => step, { concurrency: 1, discard: true }).pipe(
        Effect.match({ onFailure: (text: string) => text, onSuccess: () => null }),
        Effect.map(finish),
      ),
    );
  };
  const lifecycles: readonly Lifecycle[] = ['DRAFT', 'ACTIVE', 'RETIRED'];
  const title = draft.name === '' ? 'Upravit produkt' : `Upravit produkt: ${draft.name}`;
  const createCategory = () => {
    const name = newCategory.trim();
    if (name === '') {
      return;
    }
    setCreating(true);
    setFailure(null);
    browserRuntime.runFork(
      send(
        'Vytvoření kategorie',
        CreateProductCategoryPayloadSchema,
        { name, reason: draft.reason.trim() === '' ? 'Nová kategorie z administrace' : draft.reason.trim() },
        executeCreateProductCategory,
      ).pipe(
        Effect.match({
          onFailure: (text: string) => {
            setCreating(false);
            setFailure(`Kategorii se nepodařilo vytvořit – ${text}.`);
          },
          onSuccess: (result) => {
            setCreating(false);
            const created = Schema.decodeUnknownOption(CreateProductCategoryResultSchema)(result);
            if (Option.isSome(created)) {
              const { category } = created.value;
              setCreatedCategories((current) => [
                ...current,
                { categoryRef: category.categoryRef, name: category.name },
              ]);
              setDraft((current) => ({
                ...current,
                categoryIds: [...new Set([...current.categoryIds, category.categoryRef.resourceId])],
              }));
              setNewCategory('');
              return;
            }
            setFailure('Vytvoření kategorie čeká na schválení.');
          },
        }),
      ),
    );
  };
  const known = new Map(
    [...categories, ...createdCategories].map(({ categoryRef, name }) => [categoryRef.resourceId, name]),
  );
  const shownCategories = [...new Set([...known.keys(), ...draft.categoryIds])];
  return (
    <Dialog
      actions={
        <div className="flex w-full flex-wrap justify-end gap-100">
          <Button disabled={busy} onClick={onClose} theme="outlined" type="button" variant="secondary">
            Zrušit
          </Button>
          <Button isLoading={busy} loadingText="Ukládám…" onClick={save} type="button" variant="primary">
            Uložit
          </Button>
        </div>
      }
      closeLabel="Zavřít"
      customTrigger
      onOpenChange={({ open }) => {
        if (!open && !busy) {
          onClose();
        }
      }}
      open
      size="lg"
      title={title}
    >
      <div className="flex flex-col gap-200">
        {Option.match(erpStorefrontStatus(item, legalEntityId), {
          onNone: () => null,
          onSome: (status) => (
            <div
              className="flex flex-col gap-50 rounded-md border border-border-primary p-150 text-sm"
              data-storefront-status={status.visible ? 'visible' : 'hidden'}
            >
              <span className="flex flex-wrap items-center gap-100">
                <span className="font-semibold">{status.visible ? 'Na e-shopu: ano' : 'Na e-shopu: ne'}</span>
                {status.href !== undefined && (
                  <a className="underline" href={status.href} rel="noreferrer" target="_blank">
                    Otevřít v e-shopu
                  </a>
                )}
              </span>
              {status.reasons.map((reason) => (
                <span key={reason.why}>
                  <span className="font-medium">{reason.why}</span> Co změnit: {reason.fix}
                </span>
              ))}
              {status.notes.map((note) => (
                <span className="text-fg-secondary" key={note}>
                  {note}
                </span>
              ))}
              <span className="text-fg-secondary">
                Stav na e-shopu odpovídá uloženému produktu; po uložení se obnoví.
              </span>
            </div>
          ),
        })}
        <label className="flex flex-col gap-50 text-sm">
          <span className="font-medium">Název ({locale})</span>
          <Input
            maxLength={240}
            onChange={(event) => update({ name: event.target.value })}
            size="sm"
            value={draft.name}
          />
        </label>
        <label className="flex flex-col gap-50 text-sm">
          <span className="font-medium">Popis ({locale})</span>
          <textarea
            className={fieldClass}
            maxLength={4000}
            onChange={(event) => update({ description: event.target.value })}
            rows={5}
            value={draft.description}
          />
        </label>
        <label className="flex flex-col gap-50 text-sm">
          <span className="font-medium">Stav (ACTIVE = zobrazeno na Novinkách z ERP)</span>
          <select
            className={fieldClass}
            onChange={(event) => {
              const lifecycle = lifecycles.find((value) => value === event.target.value);
              if (lifecycle !== undefined) {
                update({ lifecycle });
              }
            }}
            value={draft.lifecycle}
          >
            {item.lifecycle !== 'RETIRED' && <option value="DRAFT">Koncept (DRAFT)</option>}
            {item.lifecycle !== 'RETIRED' && <option value="ACTIVE">Aktivní (ACTIVE)</option>}
            <option value="RETIRED">Vyřazený (RETIRED)</option>
            {item.lifecycle === 'RETIRED' && <option value="DRAFT">Obnovit</option>}
          </select>
        </label>
        <fieldset className="flex flex-col gap-50 text-sm">
          <legend className="font-medium">Kategorie</legend>
          {shownCategories.map((id) => (
            <label className="flex items-center gap-100" key={id}>
              <input
                checked={draft.categoryIds.includes(id)}
                onChange={(event) => toggleCategory(id, event.target.checked)}
                type="checkbox"
              />
              {known.get(id) ?? id}
            </label>
          ))}
          <div className="flex gap-100">
            <Input
              aria-label="Název nové kategorie"
              maxLength={240}
              onChange={(event) => setNewCategory(event.target.value)}
              placeholder={`Název nové kategorie (${locale})`}
              size="sm"
              value={newCategory}
            />
            <Button
              disabled={busy}
              isLoading={creating}
              loadingText="Vytvářím…"
              onClick={createCategory}
              size="sm"
              theme="outlined"
              type="button"
              variant="secondary"
            >
              Vytvořit a přidat
            </Button>
          </div>
        </fieldset>
        <fieldset className="flex flex-col gap-100 text-sm">
          <legend className="font-medium">Varianty</legend>
          {item.variants.map((variant) => {
            const id = variant.variantRef.resourceId;
            const value = draft.variants[id];
            return value === undefined ? null : (
              <div className="grid grid-cols-[1fr_1fr_auto] items-center gap-100" key={id}>
                <Input
                  aria-label="Název varianty"
                  onChange={(event) => updateVariant(id, { name: event.target.value })}
                  placeholder="Název varianty"
                  size="sm"
                  value={value.name}
                />
                <Input
                  aria-label="SKU"
                  onChange={(event) => updateVariant(id, { sku: event.target.value })}
                  placeholder="SKU"
                  size="sm"
                  value={value.sku}
                />
                <label className="flex items-center gap-50">
                  <input
                    checked={value.retired}
                    onChange={(event) => updateVariant(id, { retired: event.target.checked })}
                    type="checkbox"
                  />
                  Vyřazená
                </label>
              </div>
            );
          })}
        </fieldset>
        <ErpMediaSection item={item} reason={draft.reason} />
        <label className="flex flex-col gap-50 text-sm" htmlFor="catalog-product-edit-reason">
          <span className="font-medium">Důvod změny</span>
          <Input
            id="catalog-product-edit-reason"
            maxLength={1000}
            onChange={(event) => update({ reason: event.target.value })}
            size="sm"
            value={draft.reason}
          />
        </label>
        <p className="text-fg-secondary text-xs">
          Obrázek se ukládá hned po výběru souboru. Cenu a sklad upravíte u varianty (Cena a sklad).
        </p>
        {failure !== null && (
          <StatusText showIcon status="error">
            {failure}
          </StatusText>
        )}
      </div>
    </Dialog>
  );
};
