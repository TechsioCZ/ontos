import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import {
  SaveBar,
  SidePanel,
  UnsavedChangesDialog,
  formatDateTime,
  requiredLabelFor,
  saveLabelsFor,
  useRecordDraft,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import type { RevisionedSaveResult } from '@app/admin-ui';
import {
  FormBuilder,
  FormReact,
  FormRoot,
  SwitchField,
  TextAreaField,
  TextField,
  unrenderedField,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { DateTime, Effect, Match, Option, Predicate, Schema } from 'effect';
import { AsyncResult, Atom } from 'effect/reactivity';
import type { Dispatch, SetStateAction } from 'react';
import { useRef, useState } from 'react';
import type { CategoryNode, ProductId } from '../../../../../shared/domain/merchandise-model.ts';
import { CatalogCategoryIdSchema } from '../../../../../shared/domain/merchandise-model.ts';
import { browserAtomRuntime, browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { useRecordForm } from '../../../../ui/record-form.ts';
import { newUuid } from './browser-crypto.ts';
import { loadCategoryDetail, loadCategoryTree, runCommand } from './products-api.ts';
import {
  categoryDraftErrors,
  categorySlugOf,
  categorySlugValid,
  createCategoryCommandOf,
  draftOf,
  newCategoryInvalid,
  sameCategoryDraft,
  saveCategoryEdit,
  savedCategory,
} from './category-save.ts';
import type { CategoryDraft, NewCategoryDraft } from './category-save.ts';
import { CategorySearchCombobox } from './category-search-combobox.tsx';
import { fieldVerdict } from './product-form-validation.ts';
import { LiveShopConfirm } from './live-shop-confirm.tsx';
import { useCommandFailure } from './product-form-labels.ts';
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
      <Button onClick={() => setOpen(true)} severity="secondary" size="sm" type="button">
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
                className="h-20 w-20 overflow-hidden rounded border border-border-secondary"
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
      <Button onClick={() => setOpen(false)} severity="secondary" size="sm" type="button">
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

const CategoryParentSchema = Schema.OptionFromNullOr(
  Schema.Struct({ id: CatalogCategoryIdSchema, trail: Schema.String }),
);

/**
 * The open category's own fields. The record draft owns them (`useRecordDraft`); typing changes only the draft, the
 * panel's Save button sends it, and Enter in a field is the same one save. The parent is picked in a search combobox
 * that writes its field.
 */
const categoryForm = FormReact.make(
  FormBuilder.empty
    .addField('description', Schema.String)
    .addField('heading', Schema.String)
    .addField('imageAlt', Schema.String)
    .addField('imageSrc', Schema.String)
    .addField('longDescription', Schema.String)
    .addField('name', Schema.String)
    .addField('parent', CategoryParentSchema)
    .addField('positionText', Schema.String)
    .addField('published', Schema.Boolean)
    .addField('slug', Schema.String),
  {
    fields: {
      description: TextAreaField,
      heading: TextField,
      imageAlt: TextField,
      imageSrc: TextField,
      longDescription: TextAreaField,
      name: TextField,
      parent: unrenderedField<CategoryDraft['parent']>(),
      positionText: TextField,
      published: SwitchField,
      slug: TextField,
    },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);
const categoryParentField = categoryForm.getFieldAtoms(categoryForm.fields.parent);
const categoryPositionField = categoryForm.getFieldAtoms(categoryForm.fields.positionText);
const categoryImageField = categoryForm.getFieldAtoms(categoryForm.fields.imageSrc);
/** The form's values are the category draft itself. */
const sameDraft = (draft: CategoryDraft): CategoryDraft => draft;
const valuesAsDraft = (values: CategoryDraft): CategoryDraft => values;

/**
 * A new category being typed. Its slug follows the name until the slug is typed; Enter or "Vytvořit kategorii"
 * creates it. The parent is picked in a search combobox that writes its field.
 */
const newCategoryForm = FormReact.make(
  FormBuilder.empty
    .addField('heading', Schema.String)
    .addField('name', Schema.String)
    .addField('parent', CategoryParentSchema)
    .addField('positionText', Schema.String)
    .addField('published', Schema.Boolean)
    .addField('slug', Schema.String)
    .addField('slugFollowsName', Schema.Boolean),
  {
    fields: {
      heading: TextField,
      name: TextField,
      parent: unrenderedField<NewCategoryDraft['parent']>(),
      positionText: TextField,
      published: SwitchField,
      slug: TextField,
      slugFollowsName: unrenderedField<boolean>(),
    },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);
type NewCategoryValues = typeof newCategoryForm.schema.Encoded;
const newCategoryFields = {
  name: newCategoryForm.getFieldAtoms(newCategoryForm.fields.name),
  parent: newCategoryForm.getFieldAtoms(newCategoryForm.fields.parent),
  slug: newCategoryForm.getFieldAtoms(newCategoryForm.fields.slug),
  slugFollowsName: newCategoryForm.getFieldAtoms(newCategoryForm.fields.slugFollowsName),
};
const newCategoryDraftOf = (values: NewCategoryValues): NewCategoryDraft => ({
  heading: values.heading,
  name: values.name,
  parent: values.parent,
  positionText: values.positionText,
  published: values.published,
  slug: values.slugFollowsName ? null : values.slug,
});
/** The typed slug as plain text, which changes only when the text does. */
const newCategorySlugText = newCategoryFields.slug.value.pipe(Atom.map(Option.getOrElse(() => '')));

/** The search over the category list. It filters the list at once; the form itself is never submitted. */
const categorySearchForm = FormReact.make(FormBuilder.empty.addField('search', Schema.String), {
  fields: { search: TextField },
  onSubmit: () => Effect.void,
  runtime: browserAtomRuntime,
});
const categorySearch = categorySearchForm.values.pipe(
  Atom.map(Option.match({ onNone: () => '', onSome: ({ search }) => search })),
);

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
  /** The record's draft (`useRecordDraft`), which owns the form's values. */
  readonly draft: CategoryDraft;
  /** The form was submitted (Enter in a field): the same one save as the Save button. */
  readonly onSave: () => void;
  readonly parentName: string | undefined;
  readonly selected: CategoryNode;
  readonly setDraft: Dispatch<SetStateAction<CategoryDraft>>;
  readonly siblings: readonly CategoryNode[];
}

/** The category's own fields. Editing them changes the draft only; the panel's Save button sends it. */
const CategoryEditor = ({
  draft: recordDraft,
  onSave,
  parentName,
  selected,
  setDraft,
  siblings,
}: CategoryEditorProps) => {
  const { language, t } = useModernI18n();
  useRecordForm({ draft: recordDraft, draftOf: valuesAsDraft, form: categoryForm, setDraft, valuesOf: sameDraft });
  // Enter in a field is the Save button.
  useAtomSubscribe(
    categoryForm.submit,
    (result) => {
      if (AsyncResult.isSuccess(result) && !result.waiting) {
        onSave();
      }
    },
    { immediate: false },
  );
  const draft = Option.getOrElse(useAtomValue(categoryForm.values), () => recordDraft);
  const setParent = useAtomSet(categoryParentField.setValue);
  const setPosition = useAtomSet(categoryPositionField.setValue);
  const setImageSrc = useAtomSet(categoryImageField.setValue);
  const { name: nameError, position: positionError, slug: slugError } = categoryDraftErrors(draft);
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
      <categoryForm.published name="categoryPublished">Zobrazit v navigaci e-shopu</categoryForm.published>
      <categoryForm.name
        id="category-name"
        label={t('merchandise.ui.name')}
        maxLength={200}
        name="name"
        required
        requiredLabel={requiredLabelFor(language)}
        {...fieldVerdict(nameError !== undefined, nameMessage)}
      />
      <categoryForm.slug
        helpText="Adresa stránky kategorie v e-shopu (/kategorie/…). Po změně přestane platit stará adresa."
        id="category-slug"
        label="Adresa (slug)"
        maxLength={200}
        name="slug"
        {...fieldVerdict(slugError !== undefined, 'Jen malá písmena bez diakritiky, číslice a pomlčky')}
      />
      <CategorySearchCombobox
        allLabel="Kořen (hlavní kategorie)"
        errorMessage="Kategorie se nepodařilo načíst."
        helpText={draft.parent === null ? 'Kořen (hlavní kategorie).' : `Pod: ${draft.parent.trail}`}
        id="category-parent"
        label="Nadřazená kategorie"
        loadingMessage="Načítám kategorie…"
        moreMessage={(shown, total) => `Zobrazeno ${shown} z ${total} kategorií. Upřesněte hledání.`}
        noResultsMessage="Žádná kategorie neodpovídá hledání."
        onSelect={setParent}
        placeholder="Hledat nadřazenou kategorii"
        retryLabel="Zkusit znovu"
        selected={
          draft.parent === null
            ? null
            : { id: CatalogCategoryIdSchema.make(draft.parent.id), trail: draft.parent.trail }
        }
      />
      <categoryForm.heading
        id="category-heading"
        label={t('merchandise.ui.categoryPageHeading')}
        maxLength={300}
        name="heading"
      />
      <categoryForm.description
        id="category-description"
        label={t('merchandise.ui.shortDescription')}
        maxLength={5000}
        name="description"
      />
      <categoryForm.longDescription
        id="category-long-description"
        label={t('merchandise.ui.categoryDescription')}
        maxLength={50_000}
        name="longDescription"
      />
      <categoryForm.imageSrc
        helpText="Akros zobrazí jen cestu začínající /…, https adresu na www.akros.cz/data/ nebo hostitele z STOREFRONT_IMAGE_HOSTS; jinou adresu vynechá. Tlačítko Vybrat z fotek produktu vloží cestu /obrazky/… k nahrané fotce; funguje, dokud je ten produkt zveřejněný."
        id="category-image-src"
        label="Obrázek kategorie (adresa)"
        maxLength={500}
        name="imageSrc"
      />
      <CategoryImagePicker onPick={setImageSrc} />
      <categoryForm.imageAlt id="category-image-alt" label="Popis obrázku" maxLength={300} name="imageAlt" />
      <categoryForm.positionText
        id="category-position"
        inputMode="numeric"
        label={t('merchandise.ui.siblingPosition')}
        name="position"
        {...fieldVerdict(positionError !== undefined, positionMessage)}
      />
      {siblings.length > 0 && (
        <div className="flex flex-col gap-100">
          <p className="text-fg-secondary text-sm">
            {`Stejné pořadí řadí podle názvu. Mezi dvě kategorie ji dáte číslem mezi jejich pořadím. Sourozenci: ${siblingNames}${siblings.length > 6 ? ', …' : ''}`}
          </p>
          <div className="flex flex-wrap gap-100">
            <Button
              appearance="outline"
              onClick={() => setPosition(String(Math.max(0, (siblings[0]?.position ?? 0) - 10)))}
              severity="secondary"
              size="sm"
              type="button"
            >
              Na začátek
            </Button>
            <Button
              appearance="outline"
              onClick={() => setPosition(String((siblings.at(-1)?.position ?? 0) + 10))}
              severity="secondary"
              size="sm"
              type="button"
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

const EMPTY_NEW_CATEGORY: NewCategoryValues = {
  heading: '',
  name: '',
  parent: null,
  positionText: '0',
  published: true,
  slug: '',
  slugFollowsName: true,
};

interface CategoryCreateFormProps {
  readonly onCancel: () => void;
  readonly onCreated: (id: string) => void;
  readonly revision: number;
}

/** The new category's name and slug, as one value: which of them changed tells whether the slug was typed. */
const nameAndSlug = newCategoryForm.values.pipe(
  Atom.map(Option.map((values) => ({ follows: values.slugFollowsName, name: values.name, slug: values.slug }))),
);

/**
 * The slug follows the name until it is typed: a changed name writes its slug while it follows, a slug typed to
 * anything else stops it following.
 */
const useSlugFollowingName = () => {
  const setSlug = useAtomSet(newCategoryFields.slug.setValue);
  const setFollows = useAtomSet(newCategoryFields.slugFollowsName.setValue);
  const previous = useRef<{ readonly name: string; readonly slug: string } | null>(null);
  useAtomSubscribe(
    nameAndSlug,
    (next) => {
      if (Option.isNone(next)) {
        return;
      }
      const { follows, name, slug } = next.value;
      const before = previous.current;
      previous.current = { name, slug };
      if (!follows || before === null) {
        return;
      }
      if (slug !== before.slug) {
        if (slug !== categorySlugOf(name)) {
          setFollows(false);
        }
      } else if (name !== before.name) {
        setSlug(categorySlugOf(name));
      }
    },
    { immediate: true },
  );
};

const CategoryCreateFields = ({ onCancel, onCreated, revision }: CategoryCreateFormProps) => {
  const { language } = useModernI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useSlugFollowingName();
  const draft = newCategoryDraftOf(Option.getOrElse(useAtomValue(newCategoryForm.values), () => EMPTY_NEW_CATEGORY));
  const setParent = useAtomSet(newCategoryFields.parent.setValue);
  const slug = useAtomValue(newCategorySlugText);
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
  // Enter in a field and the button create the category.
  useAtomSubscribe(
    newCategoryForm.submit,
    (result) => {
      if (AsyncResult.isSuccess(result) && !result.waiting) {
        submit();
      }
    },
    { immediate: false },
  );
  return (
    <>
      <h3 className="font-semibold text-sm">Nová kategorie</h3>
      <newCategoryForm.name
        id="new-category-name"
        label="Název"
        maxLength={200}
        name="newCategoryName"
        required
        requiredLabel={requiredLabelFor(language)}
      />
      <newCategoryForm.slug
        helpText="Adresa v e-shopu; po vytvoření ji nelze změnit."
        id="new-category-slug"
        label="Adresa (slug)"
        maxLength={200}
        name="newCategorySlug"
        {...fieldVerdict(!categorySlugValid(slug), 'Jen malá písmena bez diakritiky, číslice a pomlčky')}
      />
      <CategorySearchCombobox
        errorMessage="Kategorie se nepodařilo načíst."
        helpText="Prázdné = hlavní kategorie. Po vytvoření nelze změnit."
        id="new-category-parent"
        label="Nadřazená kategorie"
        loadingMessage="Načítám kategorie…"
        moreMessage={(shown, total) => `Zobrazeno ${shown} z ${total} kategorií. Upřesněte hledání.`}
        noResultsMessage="Žádná kategorie neodpovídá hledání."
        onSelect={setParent}
        placeholder="Hledat nadřazenou kategorii"
        retryLabel="Zkusit znovu"
        selected={
          draft.parent === null
            ? null
            : { id: CatalogCategoryIdSchema.make(draft.parent.id), trail: draft.parent.trail }
        }
      />
      <newCategoryForm.heading
        id="new-category-heading"
        label="Nadpis stránky (prázdné = název)"
        maxLength={300}
        name="newCategoryHeading"
      />
      <newCategoryForm.positionText
        id="new-category-position"
        inputMode="numeric"
        label="Pořadí mezi sourozenci"
        name="newCategoryPosition"
      />
      <newCategoryForm.published name="newCategoryPublished">Zobrazit v navigaci e-shopu</newCategoryForm.published>
      {error === null ? null : (
        <StatusText showIcon status="error">
          {error}
        </StatusText>
      )}
      <div className="flex flex-wrap gap-100">
        <Button disabled={invalid} isLoading={busy} severity="primary" type="submit">
          Vytvořit kategorii
        </Button>
        <Button appearance="outline" onClick={onCancel} severity="secondary" type="button">
          Zrušit
        </Button>
      </div>
    </>
  );
};

/** A new storefront category. Slug and parent are set here once; the rest is edited afterwards like any category. */
const CategoryCreateForm = (props: CategoryCreateFormProps) => {
  const { t } = useModernI18n();
  return (
    <FormRoot
      className="flex flex-col gap-200 rounded border border-border-secondary p-200"
      defaultValues={EMPTY_NEW_CATEGORY}
      form={newCategoryForm}
      translateMessage={t}
    >
      <CategoryCreateFields {...props} />
    </FormRoot>
  );
};

/**
 * Deletes the category after a confirmation that names it. The server refuses a category that still has a subcategory
 * or a product that is not archived; a category with subcategories cannot even be asked for.
 */
const CategoryDeleteSection = ({
  category,
  disabled,
  onDeleted,
  onReload,
  revision,
}: {
  readonly category: CategoryNode;
  readonly disabled: boolean;
  readonly onDeleted: () => void;
  readonly onReload: () => void;
  readonly revision: number;
}) => {
  const failure = useCommandFailure();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handleConfirm = () => {
    setAsking(false);
    setBusy(true);
    setError(null);
    runCommand({ _tag: 'DeleteCategory', id: category.id }, revision, (outcome) => {
      setBusy(false);
      if (outcome.ok) {
        onDeleted();
        return;
      }
      setError(
        outcome.reason === 'rejected' && outcome.proposal === undefined
          ? 'Kategorii nelze smazat: má podkategorie nebo v ní jsou produkty. Přesuňte je do jiné kategorie, nebo produkty archivujte.'
          : failure(outcome.reason, onReload, outcome.proposal),
      );
    });
  };
  return (
    <div className="flex flex-col gap-100 border-border-secondary border-t pt-200">
      <p className="text-fg-secondary text-sm">
        {category.hasChildren
          ? 'Kategorii s podkategoriemi nelze smazat. Nejdřív smažte nebo přesuňte její podkategorie.'
          : 'Smazat lze jen prázdnou kategorii: bez podkategorií a bez produktů (archivované produkty se nepočítají).'}
      </p>
      <Button
        appearance="outline"
        data-testid="category-delete"
        disabled={disabled || busy || category.hasChildren}
        isLoading={busy}
        onClick={() => setAsking(true)}
        severity="danger"
        type="button"
      >
        Smazat kategorii
      </Button>
      {error !== null && (
        <StatusText showIcon status="error">
          {error}
        </StatusText>
      )}
      <LiveShopConfirm
        confirmLabel="Smazat"
        description={`Kategorie „${category.name}“ zmizí ze stromu kategorií i z e-shopu. Smazání nelze vrátit.`}
        destructive
        onCancel={() => setAsking(false)}
        onConfirm={handleConfirm}
        open={asking}
        title={`Smazat kategorii ${category.name}?`}
      />
    </div>
  );
};

interface CategoryEditPanelProps {
  readonly category: CategoryNode;
  readonly onBack: () => void;
  readonly onDeleted: () => void;
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
const CategoryEditPanel = ({
  category,
  onBack,
  onDeleted,
  onSaved,
  parentName,
  revision,
  siblings,
}: CategoryEditPanelProps) => {
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
    server: draftOf(category, parentName),
  });
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({ draft: record, navigation: blocker, onDiscard: record.discard });
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
            <Button appearance="outline" onClick={close} severity="secondary">
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
        <FormRoot
          className="flex flex-col gap-200 py-200"
          defaultValues={record.draft}
          form={categoryForm}
          translateMessage={t}
        >
          <p className="text-fg-secondary text-sm">Uložené změny uvidí zákazník v e-shopu.</p>
          <CategoryEditor
            draft={record.draft}
            onSave={handleSave}
            parentName={parentName}
            selected={category}
            setDraft={record.setDraft}
            siblings={siblings}
          />
        </FormRoot>
        <CategoryDeleteSection
          category={category}
          disabled={record.dirty}
          onDeleted={onDeleted}
          onReload={handleReloadLatest}
          revision={revision}
        />
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
  const search = useAtomValue(categorySearch);
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

  /** A deleted category leaves the editor for the reread list. */
  const deleted = () => {
    setSelection(null);
    setSavedOnce(false);
    reload();
    onCommitted('Kategorie smazána.');
  };

  return {
    backToList,
    categories,
    commitSaved,
    created,
    creating,
    deleted,
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
    deleted,
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
    siblings,
    t,
  } = model;
  const listState = categoryListState(model);

  return (
    <>
      {/* The list's search survives opening a category and coming back, as long as the page shows the button. */}
      <categorySearchForm.KeepAlive />
      <Button
        appearance="outline"
        icon="icon-[mdi--file-tree-outline]"
        onClick={openPanel}
        severity="secondary"
        size="sm"
      >
        Kategorie e-shopu
      </Button>
      {selection?.status === 'ready' && selected !== undefined ? (
        <CategoryEditPanel
          category={selected}
          key={selection.id}
          onBack={backToList}
          onDeleted={deleted}
          onSaved={commitSaved}
          parentName={parentName}
          revision={selection.revision}
          siblings={siblings}
        />
      ) : (
        <SidePanel
          actions={
            <Button appearance="outline" onClick={() => setOpen(false)} severity="secondary">
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
                <Button onClick={reload} severity="secondary">
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
                appearance="outline"
                icon="icon-[mdi--plus]"
                onClick={() => setCreating(true)}
                severity="secondary"
                size="sm"
              >
                Nová kategorie
              </Button>
            ) : null}
            {listState.visible && loaded.status === 'ready' && (
              <>
                <FormRoot defaultValues={{ search: '' }} form={categorySearchForm} translateMessage={t}>
                  <categorySearchForm.search
                    id="category-admin-search"
                    label={t('merchandise.ui.searchCategories')}
                    name="categorySearch"
                    placeholder={t('merchandise.ui.categorySearchPlaceholder')}
                    size="sm"
                  />
                </FormRoot>
                <p className="text-fg-secondary text-sm">
                  {search.trim() === ''
                    ? 'Hlavní kategorie podle pořadí v e-shopu. Pro podkategorie použijte hledání.'
                    : `Nalezeno: ${list.length}`}
                </p>
                <ul className="flex flex-col gap-100">
                  {list.map((c) => (
                    <li key={c.id}>
                      <Button
                        appearance="ghost"
                        className="h-auto w-full justify-start whitespace-normal text-left"
                        onClick={() => select(c.id)}
                        severity="secondary"
                        size="sm"
                        type="button"
                      >
                        <span className="block w-full text-left">
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
                <Button onClick={() => select(selection.id)} severity="secondary">
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
