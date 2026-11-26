import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { FormInput, FormTextarea, Switch } from '@app/admin-ui/form-controls';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import {
  SaveBar,
  SidePanel,
  UnsavedChangesDialog,
  formatDateTime,
  saveLabelsFor,
  useRecordDraft,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import type { RevisionedSaveResult } from '@app/admin-ui';
import { DateTime, Effect, Match, Option, Predicate } from 'effect';
import { useState } from 'react';
import type { CategoryNode, ProductId } from '../../../../../shared/domain/merchandise-model.ts';
import { CatalogCategoryIdSchema } from '../../../../../shared/domain/merchandise-model.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { newUuid } from './browser-crypto.ts';
import { loadCategoryDetail, loadCategoryTree, runCommand } from './products-api.ts';
import {
  categoryDraftErrors,
  categorySlugValid,
  createCategoryCommandOf,
  draftOf,
  newCategoryInvalid,
  newCategorySlug,
  sameCategoryDraft,
  saveCategoryEdit,
  savedCategory,
} from './category-save.ts';
import type { CategoryDraft, NewCategoryDraft } from './category-save.ts';
import { CategorySearchCombobox } from './category-search-combobox.tsx';
import { fieldError } from './product-form-validation.ts';
import { loadProductRecord } from './product-reads.ts';
import type { ProductRecordState } from './product-reads.ts';
import { useImageSource } from './product-image-source.ts';
import { ProductSearchCombobox } from './product-search.tsx';
import type { ProductRecord } from '../../../../../shared/apis/records.ts';

/** An uploaded photo's admin preview: the governed media read, since the shell has no /obrazky route. */
const PickerThumbnail = ({ image, productId }: { readonly image: string; readonly productId: ProductId }) => {
  const source = useImageSource(productId, image, 'thumbnail');
  return source.status === 'ready' ? <img alt="" className="h-full w-full object-cover" src={source.src} /> : null;
};

/** Picks an uploaded product photo (a 'media:' gallery ref) and returns its same-origin /obrazky path. */
const CategoryImagePicker = ({ onPick }: { readonly onPick: (src: string) => void }) => {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<ProductRecord | null>(null);
  const [state, setState] = useState<ProductRecordState>({ status: 'idle' });
  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} size="sm" type="button" variant="secondary">
        Vybrat z fotek produktu
      </Button>
    );
  }
  const select = (product: ProductRecord | null) => {
    setPicked(product);
    if (product === null) {
      setState({ status: 'idle' });
      return;
    }
    setState({ status: 'loading' });
    loadProductRecord(product.id, setState);
  };
  const refs = state.status === 'ready' ? (state.product.images ?? []).filter((ref) => ref.startsWith('media:')) : [];
  return (
    <div className="flex flex-col gap-100 rounded border border-border-secondary p-150">
      <ProductSearchCombobox
        errorMessage="Hledání selhalo."
        id="category-image-product"
        label="Produkt s nahranými fotkami"
        loadingMessage="Hledám…"
        noResultsMessage="Nic nenalezeno."
        onSelect={select}
        placeholder="Název nebo kód produktu"
        retryLabel="Zkusit znovu"
        selected={picked}
      />
      {state.status === 'loading' ? <p className="text-fg-secondary text-sm">Načítám fotky…</p> : null}
      {state.status === 'error' ? <p className="text-fg-secondary text-sm">Načtení produktu selhalo.</p> : null}
      {state.status === 'ready' && refs.length === 0 ? (
        <p className="text-fg-secondary text-sm">Produkt nemá nahrané fotky.</p>
      ) : null}
      {state.status === 'ready' ? (
        <div className="flex flex-wrap gap-100">
          {refs.map((ref) => {
            const src = `/obrazky/${encodeURIComponent(state.product.id)}/${ref.slice('media:'.length)}`;
            return (
              <button
                aria-label="Použít tuto fotku"
                className="h-[80px] w-[80px] overflow-hidden rounded border border-border-secondary"
                key={ref}
                onClick={() => {
                  onPick(src);
                  setOpen(false);
                }}
                type="button"
              >
                <PickerThumbnail image={ref} productId={state.product.id} />
              </button>
            );
          })}
        </div>
      ) : null}
      <Button onClick={() => setOpen(false)} size="sm" type="button" variant="secondary">
        Zavřít
      </Button>
    </div>
  );
};

type Loaded =
  | { readonly status: 'idle' | 'loading' | 'error' }
  | { readonly categories: readonly CategoryNode[]; readonly revision: number; readonly status: 'ready' };

/** The category being edited: the tree carries only navigation fields, so its content is read on selection. */
type Selected =
  | { readonly id: string; readonly status: 'loading' | 'error' }
  | { readonly category: CategoryNode; readonly id: string; readonly revision: number; readonly status: 'ready' };

const NO_CATEGORIES: readonly CategoryNode[] = [];

/** The storefront's own order: position, then Czech name. */
const byStorefrontOrder = (a: CategoryNode, b: CategoryNode) =>
  a.position - b.position || a.name.localeCompare(b.name, 'cs');

const loadCategories = (onLoaded: (next: Loaded) => void): void =>
  loadCategoryTree((outcome) =>
    onLoaded(
      outcome.ok
        ? { categories: outcome.response.categories ?? [], revision: outcome.response.revision, status: 'ready' }
        : { status: 'error' },
    ),
  );

const categoryListFor = (categories: readonly CategoryNode[], search: string) => {
  const needle = search.trim().toLocaleLowerCase('cs');
  const matches =
    needle === ''
      ? categories.filter((c) => Option.isNone(c.parentId)).toSorted(byStorefrontOrder)
      : categories
          .filter((c) => c.name.toLocaleLowerCase('cs').includes(needle) || c.slug.includes(needle))
          .toSorted(byStorefrontOrder);
  return matches.slice(0, 40);
};

const categoryParentId = (selected: CategoryNode | undefined) => Option.getOrNull(selected?.parentId ?? Option.none());
const categoryParentName = (categories: readonly CategoryNode[], parentId: string | null) =>
  parentId === null ? undefined : categories.find((c) => c.id === parentId)?.name;

interface CategoryAdminButtonProps {
  readonly onCommitted: (message: string) => void;
}

const CategoryHistory = ({ selected }: { readonly selected: CategoryNode }) => (
  <>
    <h3 className="font-semibold text-sm">Historie změn</h3>
    {(selected.history ?? []).length === 0 ? (
      <p className="text-fg-secondary text-sm">Zatím žádné změny kategorie.</p>
    ) : (
      <ul className="flex flex-col gap-100 text-sm">
        {[...(selected.history ?? [])]
          .toSorted((a, b) => DateTime.toEpochMillis(b.at) - DateTime.toEpochMillis(a.at))
          .map((entry) => (
            <li key={`${DateTime.formatIso(entry.at)}-${entry.fields.join(',')}`}>
              {`${formatDateTime(DateTime.formatIso(entry.at))} — ${entry.fields.join(', ')}: ${entry.before} → ${entry.after}`}
            </li>
          ))}
      </ul>
    )}
  </>
);

interface CategoryEditorProps {
  readonly draft: CategoryDraft;
  readonly nameError: 'required' | 'tooLong' | undefined;
  readonly parentName: string | undefined;
  readonly patchDraft: (patch: Partial<CategoryDraft>) => void;
  readonly positionError: 'negative' | 'notWhole' | 'required' | undefined;
  readonly selected: CategoryNode;
  readonly siblings: readonly CategoryNode[];
}

/** The category's own fields. Editing them changes the draft only; the panel's Save button sends it. */
const CategoryEditor = ({
  draft,
  nameError,
  parentName,
  patchDraft,
  positionError,
  selected,
  siblings,
}: CategoryEditorProps) => {
  const { t } = useModernI18n();
  const siblingNames = siblings
    .slice(0, 6)
    .map((c) => `${c.name} (${c.position})`)
    .join(', ');
  const parentDescription = parentName === undefined ? '' : ` · nadřazená kategorie: ${parentName}`;
  const nameMessage = nameError === 'required' ? 'Zadejte název kategorie' : 'Název může mít nejvýše 200 znaků';
  const positionMessage = Match.value(positionError).pipe(
    Match.when('required', () => 'Zadejte pořadí'),
    Match.when('negative', () => 'Pořadí musí být 0 nebo větší'),
    Match.when('notWhole', () => 'Pořadí musí být celé číslo'),
    Match.orElse(() => ''),
  );
  return (
    <>
      <p className="text-fg-secondary text-sm">{`Adresa v e-shopu: /${selected.slug}${parentDescription}`}</p>
      <Switch
        checked={draft.published}
        name="categoryPublished"
        onCheckedChange={(published) => patchDraft({ published })}
      >
        Zobrazit v navigaci e-shopu
      </Switch>
      <FormInput
        id="category-name"
        label={t('merchandise.ui.name')}
        maxLength={200}
        name="name"
        onChange={(event) => patchDraft({ name: event.target.value })}
        required
        value={draft.name}
        {...(nameError === undefined ? {} : { helpText: nameMessage, validateStatus: 'error' as const })}
      />
      <FormInput
        id="category-heading"
        label={t('merchandise.ui.categoryPageHeading')}
        maxLength={300}
        name="heading"
        onChange={(event) => patchDraft({ heading: event.target.value })}
        value={draft.heading}
      />
      <FormTextarea
        id="category-description"
        label={t('merchandise.ui.shortDescription')}
        maxLength={5000}
        name="description"
        onChange={(event) => patchDraft({ description: event.target.value })}
        value={draft.description}
      />
      <FormTextarea
        id="category-long-description"
        label={t('merchandise.ui.categoryDescription')}
        maxLength={50_000}
        name="longDescription"
        onChange={(event) => patchDraft({ longDescription: event.target.value })}
        value={draft.longDescription}
      />
      <FormInput
        helpText="Akros zobrazí jen cestu začínající /…, https adresu na www.akros.cz/data/ nebo hostitele z STOREFRONT_IMAGE_HOSTS; jinou adresu vynechá. Tlačítko Vybrat z fotek produktu vloží cestu /obrazky/… k nahrané fotce; funguje, dokud je ten produkt zveřejněný."
        id="category-image-src"
        label="Obrázek kategorie (adresa)"
        maxLength={500}
        name="imageSrc"
        onChange={(event) => patchDraft({ imageSrc: event.target.value })}
        value={draft.imageSrc}
      />
      <CategoryImagePicker onPick={(src) => patchDraft({ imageSrc: src })} />
      <FormInput
        id="category-image-alt"
        label="Popis obrázku"
        maxLength={300}
        name="imageAlt"
        onChange={(event) => patchDraft({ imageAlt: event.target.value })}
        value={draft.imageAlt}
      />
      <FormInput
        id="category-position"
        inputMode="numeric"
        label={t('merchandise.ui.siblingPosition')}
        name="position"
        onChange={(event) => patchDraft({ positionText: event.target.value })}
        value={draft.positionText}
        {...(positionError === undefined ? {} : { helpText: positionMessage, validateStatus: 'error' as const })}
      />
      {siblings.length > 0 && (
        <div className="flex flex-col gap-100">
          <p className="text-fg-secondary text-sm">
            {`Stejné pořadí řadí podle názvu. Mezi dvě kategorie ji dáte číslem mezi jejich pořadím. Sourozenci: ${siblingNames}${siblings.length > 6 ? ', …' : ''}`}
          </p>
          <div className="flex flex-wrap gap-100">
            <Button
              onClick={() => patchDraft({ positionText: String(Math.max(0, (siblings[0]?.position ?? 0) - 10)) })}
              size="sm"
              theme="outlined"
              type="button"
              variant="secondary"
            >
              Na začátek
            </Button>
            <Button
              onClick={() => patchDraft({ positionText: String((siblings.at(-1)?.position ?? 0) + 10) })}
              size="sm"
              theme="outlined"
              type="button"
              variant="secondary"
            >
              Na konec
            </Button>
          </div>
        </div>
      )}
      <CategoryHistory selected={selected} />
    </>
  );
};

const EMPTY_NEW_CATEGORY: NewCategoryDraft = {
  heading: '',
  name: '',
  parent: null,
  positionText: '0',
  published: true,
  slug: null,
};

interface CategoryCreateFormProps {
  readonly onCancel: () => void;
  readonly onCreated: (id: string) => void;
  readonly revision: number;
}

/** A new storefront category. Slug and parent are set here once; the rest is edited afterwards like any category. */
const CategoryCreateForm = ({ onCancel, onCreated, revision }: CategoryCreateFormProps) => {
  const [draft, setDraft] = useState<NewCategoryDraft>(EMPTY_NEW_CATEGORY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const patch = (next: Partial<NewCategoryDraft>) => setDraft((current) => ({ ...current, ...next }));
  const slug = newCategorySlug(draft);
  const invalid = newCategoryInvalid(draft);
  const submit = () => {
    if (invalid || busy) {
      return;
    }
    const id = `ontos-category-${browserRuntime.runSync(newUuid)}`;
    setBusy(true);
    setError(null);
    runCommand(createCategoryCommandOf(draft, id), revision, (outcome) => {
      setBusy(false);
      if (!outcome.ok) {
        setError(
          outcome.reason === 'conflict'
            ? 'Kategorii se nepodařilo vytvořit: adresa už existuje nebo se katalog mezitím změnil. Zkuste jinou adresu.'
            : 'Kategorii se nepodařilo vytvořit.',
        );
        return;
      }
      onCreated(id);
    });
  };
  return (
    <form
      className="flex flex-col gap-200 rounded border border-border-secondary p-200"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <h3 className="font-semibold text-sm">Nová kategorie</h3>
      <FormInput
        id="new-category-name"
        label="Název"
        maxLength={200}
        name="newCategoryName"
        onChange={(event) => patch({ name: event.target.value })}
        required
        value={draft.name}
      />
      <FormInput
        helpText="Adresa v e-shopu; po vytvoření ji nelze změnit."
        id="new-category-slug"
        label="Adresa (slug)"
        maxLength={200}
        name="newCategorySlug"
        onChange={(event) => patch({ slug: event.target.value })}
        value={slug}
        {...fieldError(!categorySlugValid(slug), 'Jen malá písmena bez diakritiky, číslice a pomlčky')}
      />
      <CategorySearchCombobox
        errorMessage="Kategorie se nepodařilo načíst."
        helpText="Prázdné = hlavní kategorie. Po vytvoření nelze změnit."
        id="new-category-parent"
        label="Nadřazená kategorie"
        loadingMessage="Načítám kategorie…"
        moreMessage={(shown, total) => `Zobrazeno ${shown} z ${total} kategorií. Upřesněte hledání.`}
        noResultsMessage="Žádná kategorie neodpovídá hledání."
        onSelect={(parent) => patch({ parent })}
        placeholder="Hledat nadřazenou kategorii"
        retryLabel="Zkusit znovu"
        selected={
          draft.parent === null
            ? null
            : { id: CatalogCategoryIdSchema.make(draft.parent.id), trail: draft.parent.trail }
        }
      />
      <FormInput
        id="new-category-heading"
        label="Nadpis stránky (prázdné = název)"
        maxLength={300}
        name="newCategoryHeading"
        onChange={(event) => patch({ heading: event.target.value })}
        value={draft.heading}
      />
      <FormInput
        id="new-category-position"
        inputMode="numeric"
        label="Pořadí mezi sourozenci"
        name="newCategoryPosition"
        onChange={(event) => patch({ positionText: event.target.value })}
        value={draft.positionText}
      />
      <Switch
        checked={draft.published}
        name="newCategoryPublished"
        onCheckedChange={(published) => patch({ published })}
      >
        Zobrazit v navigaci e-shopu
      </Switch>
      {error === null ? null : (
        <StatusText showIcon status="error">
          {error}
        </StatusText>
      )}
      <div className="flex flex-wrap gap-100">
        <Button disabled={invalid} isLoading={busy} type="submit" variant="primary">
          Vytvořit kategorii
        </Button>
        <Button onClick={onCancel} theme="outlined" type="button" variant="secondary">
          Zrušit
        </Button>
      </div>
    </form>
  );
};

interface CategoryEditPanelProps {
  readonly category: CategoryNode;
  readonly onBack: () => void;
  readonly onSaved: (next: CategoryNode, revision: number) => void;
  readonly parentName: string | undefined;
  readonly revision: number;
  readonly siblings: readonly CategoryNode[];
}

/**
 * Edit an existing category. Editing changes the draft only; the Save button in the panel footer sends it against the
 * revision the draft builds on. When someone else changed the category, the panel offers the version they saved
 * instead. Leaving with unsaved changes asks first.
 */
const CategoryEditPanel = ({ category, onBack, onSaved, parentName, revision, siblings }: CategoryEditPanelProps) => {
  const { language, t } = useModernI18n();
  const labels = saveLabelsFor(language);
  const record = useRecordDraft<CategoryDraft, never>({
    equals: sameCategoryDraft,
    isValid: (value) => Object.keys(categoryDraftErrors(value)).length === 0,
    revision,
    runtime: browserRuntime,
    save: (value, expectedRevision): Effect.Effect<RevisionedSaveResult> =>
      saveCategoryEdit(value, category, expectedRevision).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            if (Predicate.isNumber(result)) {
              onSaved(savedCategory(category, value), result);
            }
          }),
        ),
      ),
    server: draftOf(category),
  });
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({ draft: record, navigation: blocker, onDiscard: record.discard });
  const { draft } = record;
  const errors = categoryDraftErrors(draft);
  const patchDraft = (patch: Partial<CategoryDraft>) => record.setDraft((current) => ({ ...current, ...patch }));
  const close = () => {
    guard.request(onBack);
  };
  const handleSave = record.save;
  const handleReloadLatest = record.reloadLatest;
  return (
    <>
      <SidePanel
        actions={
          <>
            <Button onClick={close} theme="outlined" variant="secondary">
              Zpět na seznam
            </Button>
            <SaveBar labels={labels} onReloadLatest={handleReloadLatest} onSave={handleSave} status={record.status} />
          </>
        }
        guard={guard}
        onOpenChange={(open) => {
          if (!open) {
            onBack();
          }
        }}
        open
        resizeLabel={t('merchandise.sidePanel.resize')}
        size="md"
        title={t('merchandise.ui.storefrontCategories')}
      >
        <form
          className="flex flex-col gap-200 py-200"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            handleSave();
          }}
        >
          <p className="text-fg-secondary text-sm">Uložené změny uvidí zákazník v e-shopu.</p>
          <CategoryEditor
            draft={draft}
            nameError={errors.name}
            parentName={parentName}
            patchDraft={patchDraft}
            positionError={errors.position}
            selected={category}
            siblings={siblings}
          />
        </form>
      </SidePanel>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};

/** Side panel for the storefront category tree: rename, heading, descriptions and sibling order. */
const useCategoryAdmin = ({ onCommitted }: CategoryAdminButtonProps) => {
  const { t } = useModernI18n();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<Loaded>({ status: 'idle' });
  const [search, setSearch] = useState('');
  const [selection, setSelection] = useState<Selected | null>(null);
  /** Whether a save landed while the panel is open: the list refreshes once, when the user leaves the editor. */
  const [savedOnce, setSavedOnce] = useState(false);
  const [creating, setCreating] = useState(false);

  const categories = loaded.status === 'ready' ? loaded.categories : NO_CATEGORIES;
  const selected = selection?.status === 'ready' ? selection.category : undefined;
  const parentId = categoryParentId(selected);
  const parentName = categoryParentName(categories, parentId);
  // Siblings in storefront order, so the editor can see where a position puts the category.
  const siblings =
    selected === undefined
      ? NO_CATEGORIES
      : categories
          .filter((c) => Option.getOrNull(c.parentId) === parentId && c.id !== selected.id)
          .toSorted(byStorefrontOrder);

  const reload = () => {
    setLoaded({ status: 'loading' });
    loadCategories(setLoaded);
  };
  /** Reads the category's content and history; the draft starts from that fresh copy. */
  const select = (id: string) => {
    setSelection({ id, status: 'loading' });
    loadCategoryDetail(id, (outcome) => {
      const category = outcome.ok ? outcome.response.categories?.find((c) => c.id === id) : undefined;
      if (!outcome.ok || category === undefined) {
        setSelection((current) => (current?.id === id ? { id, status: 'error' } : current));
        return;
      }
      setSelection((current) =>
        current?.id === id ? { category, id, revision: outcome.response.revision, status: 'ready' } : current,
      );
    });
  };
  const openPanel = () => {
    setOpen(true);
    setSelection(null);
    reload();
  };

  const list = categoryListFor(categories, search);

  /** A saved draft: the panel continues from the revision the server confirmed, the list shows the new values. */
  const commitSaved = (next: CategoryNode, revision: number) => {
    setSelection({ category: next, id: next.id, revision, status: 'ready' });
    setLoaded((current) =>
      current.status === 'ready'
        ? {
            ...current,
            categories: current.categories.map((c) => (c.id === next.id ? { ...c, ...next } : c)),
            revision,
          }
        : current,
    );
    setSavedOnce(true);
  };

  const backToList = () => {
    setSelection(null);
    if (savedOnce) {
      setSavedOnce(false);
      onCommitted('Kategorie uložena. Změnu uvidí zákazník v e-shopu po obnovení stránky.');
    }
  };

  const created = (id: string) => {
    setCreating(false);
    reload();
    select(id);
    setSavedOnce(true);
  };

  return {
    backToList,
    categories,
    commitSaved,
    created,
    creating,
    list,
    loaded,
    open,
    openPanel,
    parentName,
    reload,
    search,
    select,
    selected,
    selection,
    setCreating,
    setOpen,
    setSearch,
    siblings,
    t,
  };
};

const categoryListState = ({ categories, loaded }: ReturnType<typeof useCategoryAdmin>) => ({
  empty: loaded.status === 'ready' && categories.length === 0,
  failed: loaded.status === 'error',
  loading: loaded.status === 'idle' || loaded.status === 'loading',
  visible: loaded.status === 'ready' && categories.length > 0,
});

export const CategoryAdminButton = (props: CategoryAdminButtonProps) => {
  const model = useCategoryAdmin(props);
  const {
    backToList,
    commitSaved,
    created,
    creating,
    list,
    loaded,
    open,
    openPanel,
    parentName,
    reload,
    search,
    select,
    selected,
    selection,
    setCreating,
    setOpen,
    setSearch,
    siblings,
    t,
  } = model;
  const listState = categoryListState(model);

  return (
    <>
      <Button icon="icon-[mdi--file-tree-outline]" onClick={openPanel} size="sm" theme="outlined" variant="secondary">
        Kategorie e-shopu
      </Button>
      {selection?.status === 'ready' && selected !== undefined ? (
        <CategoryEditPanel
          category={selected}
          key={selection.id}
          onBack={backToList}
          onSaved={commitSaved}
          parentName={parentName}
          revision={selection.revision}
          siblings={siblings}
        />
      ) : (
        <SidePanel
          actions={
            <Button onClick={() => setOpen(false)} theme="outlined" variant="secondary">
              Zavřít
            </Button>
          }
          onOpenChange={setOpen}
          open={open}
          resizeLabel={t('merchandise.sidePanel.resize')}
          size="md"
          title={t('merchandise.ui.storefrontCategories')}
        >
          <div className="flex flex-col gap-200 py-200">
            {listState.loading && <StatusText>Načítám kategorie…</StatusText>}
            {listState.failed && (
              <>
                <StatusText showIcon status="error">
                  Kategorie se nepodařilo načíst.
                </StatusText>
                <Button onClick={reload} variant="secondary">
                  Zkusit znovu
                </Button>
              </>
            )}
            {listState.empty && <p className="text-fg-secondary text-sm">Tato firma nemá kategorie e-shopu.</p>}
            {loaded.status === 'ready' && creating ? (
              <CategoryCreateForm onCancel={() => setCreating(false)} onCreated={created} revision={loaded.revision} />
            ) : null}
            {loaded.status === 'ready' && !creating ? (
              <Button
                icon="icon-[mdi--plus]"
                onClick={() => setCreating(true)}
                size="sm"
                theme="outlined"
                variant="secondary"
              >
                Nová kategorie
              </Button>
            ) : null}
            {listState.visible && loaded.status === 'ready' && (
              <>
                <FormInput
                  id="category-admin-search"
                  label={t('merchandise.ui.searchCategories')}
                  name="categorySearch"
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t('merchandise.ui.categorySearchPlaceholder')}
                  size="sm"
                  value={search}
                />
                <p className="text-fg-secondary text-sm">
                  {search.trim() === ''
                    ? 'Hlavní kategorie podle pořadí v e-shopu. Pro podkategorie použijte hledání.'
                    : `Nalezeno: ${list.length}`}
                </p>
                <ul className="flex flex-col gap-100">
                  {list.map((c) => (
                    <li key={c.id}>
                      <Button
                        className="h-auto w-full justify-start whitespace-normal text-left"
                        onClick={() => select(c.id)}
                        size="sm"
                        theme="borderless"
                        type="button"
                        variant="secondary"
                      >
                        <span className="block w-full text-left" style={{ textAlign: 'left' }}>
                          {`${c.name} · /${c.slug} · pořadí ${c.position}${c.published === false ? ' · Skryto' : ' · Zveřejněno'}`}
                        </span>
                      </Button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {selection?.status === 'loading' && <StatusText>Načítám kategorii…</StatusText>}
            {selection?.status === 'error' && (
              <>
                <StatusText showIcon status="error">
                  Kategorii se nepodařilo načíst.
                </StatusText>
                <Button onClick={() => select(selection.id)} variant="secondary">
                  Zkusit znovu
                </Button>
              </>
            )}
          </div>
        </SidePanel>
      )}
    </>
  );
};
