import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Switch } from '@techsio/ui-kit/molecules/switch';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { SidePanel, formatDateTime } from '@app/admin-ui';
import { DateTime, Option } from 'effect';
import { useState } from 'react';
import type { CategoryNode } from '../../../../../shared/domain/merchandise-model.ts';
import { loadCategoryDetail, loadCategoryTree, runCommand } from './products-api.ts';
import { useCommandFailure } from './product-forms.tsx';

type Loaded =
  | { readonly status: 'idle' | 'loading' | 'error' }
  | { readonly categories: readonly CategoryNode[]; readonly revision: number; readonly status: 'ready' };

/** The category being edited: the tree carries only navigation fields, so its content is read on selection. */
type Selected =
  | { readonly id: string; readonly status: 'loading' | 'error' }
  | { readonly category: CategoryNode; readonly id: string; readonly revision: number; readonly status: 'ready' };

interface CategoryDraft {
  readonly description: string;
  readonly heading: string;
  readonly longDescription: string;
  readonly name: string;
  readonly positionText: string;
  readonly published: boolean;
}

const NO_CATEGORIES: readonly CategoryNode[] = [];

/** The storefront's own order: position, then Czech name. */
const byStorefrontOrder = (a: CategoryNode, b: CategoryNode) =>
  a.position - b.position || a.name.localeCompare(b.name, 'cs');

const draftOf = (c: CategoryNode): CategoryDraft => ({
  description: c.description ?? '',
  heading: c.heading ?? '',
  longDescription: c.longDescription ?? '',
  name: c.name,
  positionText: String(c.position),
  published: c.published !== false,
});

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

const validateCategoryDraft = (draft: CategoryDraft | null) => {
  const position = Number(draft?.positionText ?? '');
  return {
    nameInvalid: draft !== null && (draft.name.trim() === '' || draft.name.trim().length > 200),
    position,
    positionInvalid:
      draft !== null && (draft.positionText.trim() === '' || !Number.isInteger(position) || position < 0),
  };
};
const categoryParentId = (selected: CategoryNode | undefined) => Option.getOrNull(selected?.parentId ?? Option.none());
const categoryParentName = (categories: readonly CategoryNode[], parentId: string | null) =>
  parentId === null ? undefined : categories.find((c) => c.id === parentId)?.name;

interface CategoryAdminButtonProps {
  readonly onCommitted: (message: string) => void;
}

interface CategoryEditorProps {
  readonly draft: CategoryDraft | null;
  readonly nameInvalid: boolean;
  readonly parentName: string | undefined;
  readonly patchDraft: (patch: Partial<CategoryDraft>) => void;
  readonly positionInvalid: boolean;
  readonly selected: CategoryNode | undefined;
  readonly serverError: string | null;
  readonly siblings: readonly CategoryNode[];
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

const CategoryEditor = ({
  draft,
  nameInvalid,
  parentName,
  patchDraft,
  positionInvalid,
  selected,
  serverError,
  siblings,
}: CategoryEditorProps) => {
  if (selected === undefined || draft === null) {
    return null;
  }
  const siblingNames = siblings
    .slice(0, 6)
    .map((c) => `${c.name} (${c.position})`)
    .join(', ');
  const parentDescription = parentName === undefined ? '' : ` · nadřazená kategorie: ${parentName}`;
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
        label="Název"
        maxLength={200}
        name="name"
        onChange={(event) => patchDraft({ name: event.target.value })}
        required
        value={draft.name}
        {...(nameInvalid ? { helpText: 'Zadejte název (nejvýše 200 znaků)', validateStatus: 'error' as const } : {})}
      />
      <FormInput
        id="category-heading"
        label="Nadpis na stránce kategorie"
        maxLength={300}
        name="heading"
        onChange={(event) => patchDraft({ heading: event.target.value })}
        value={draft.heading}
      />
      <FormTextarea
        id="category-description"
        label="Krátký popis"
        maxLength={5000}
        name="description"
        onChange={(event) => patchDraft({ description: event.target.value })}
        value={draft.description}
      />
      <FormTextarea
        id="category-long-description"
        label="Popis kategorie"
        maxLength={50_000}
        name="longDescription"
        onChange={(event) => patchDraft({ longDescription: event.target.value })}
        value={draft.longDescription}
      />
      <FormInput
        id="category-position"
        inputMode="numeric"
        label="Pořadí mezi sourozenci (menší číslo = výš)"
        name="position"
        onChange={(event) => patchDraft({ positionText: event.target.value })}
        value={draft.positionText}
        {...(positionInvalid ? { helpText: 'Zadejte celé číslo 0 nebo větší', validateStatus: 'error' as const } : {})}
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
      {serverError !== null && (
        <StatusText showIcon status="error">
          {serverError}
        </StatusText>
      )}
      <CategoryHistory selected={selected} />
    </>
  );
};

/** Side panel for the storefront category tree: rename, heading, descriptions and sibling order. */
const useCategoryAdmin = ({ onCommitted }: CategoryAdminButtonProps) => {
  const { t } = useModernI18n();
  const failure = useCommandFailure();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<Loaded>({ status: 'idle' });
  const [search, setSearch] = useState('');
  const [selection, setSelection] = useState<Selected | null>(null);
  const [draft, setDraft] = useState<CategoryDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

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
    setDraft(null);
    setServerError(null);
    loadCategoryDetail(id, (outcome) => {
      const category = outcome.ok ? outcome.response.categories?.find((c) => c.id === id) : undefined;
      if (!outcome.ok || category === undefined) {
        setSelection((current) => (current?.id === id ? { id, status: 'error' } : current));
        return;
      }
      setSelection((current) =>
        current?.id === id ? { category, id, revision: outcome.response.revision, status: 'ready' } : current,
      );
      setDraft(draftOf(category));
    });
  };
  const openPanel = () => {
    setOpen(true);
    setSelection(null);
    setDraft(null);
    reload();
  };

  const list = categoryListFor(categories, search);

  const patchDraft = (patch: Partial<CategoryDraft>) =>
    setDraft((current) => (current === null ? current : { ...current, ...patch }));

  const { nameInvalid, position, positionInvalid } = validateCategoryDraft(draft);

  const save = () => {
    if (selection?.status !== 'ready' || draft === null || busy || positionInvalid || nameInvalid) {
      return;
    }
    const { category, revision } = selection;
    setBusy(true);
    setServerError(null);
    runCommand(
      {
        _tag: 'UpdateCategory',
        id: category.id,
        patch: {
          description: draft.description.trim(),
          heading: draft.heading.trim(),
          longDescription: draft.longDescription.trim(),
          name: draft.name.trim(),
          position,
          published: draft.published,
        },
      },
      revision,
      (outcome) => {
        setBusy(false);
        if (!outcome.ok) {
          setServerError(failure(outcome.reason, () => select(category.id)));
          return;
        }
        onCommitted('Kategorie uložena. Změnu uvidí zákazník v e-shopu po obnovení stránky.');
        reload();
        select(category.id);
      },
    );
  };

  const backToList = () => {
    setSelection(null);
    setDraft(null);
    setServerError(null);
  };

  return {
    backToList,
    busy,
    categories,
    draft,
    list,
    loaded,
    nameInvalid,
    open,
    openPanel,
    parentName,
    patchDraft,
    positionInvalid,
    reload,
    save,
    search,
    select,
    selected,
    selection,
    serverError,
    setOpen,
    setSearch,
    siblings,
    t,
  };
};

const categoryListState = ({ categories, loaded, selection }: ReturnType<typeof useCategoryAdmin>) => ({
  empty: loaded.status === 'ready' && categories.length === 0,
  failed: loaded.status === 'error',
  loading: loaded.status === 'idle' || loaded.status === 'loading',
  visible: loaded.status === 'ready' && categories.length > 0 && selection === null,
});

export const CategoryAdminButton = (props: CategoryAdminButtonProps) => {
  const model = useCategoryAdmin(props);
  const {
    backToList,
    busy,
    draft,
    list,
    nameInvalid,
    open,
    openPanel,
    parentName,
    patchDraft,
    positionInvalid,
    reload,
    save,
    search,
    select,
    selected,
    selection,
    serverError,
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
      <SidePanel
        actions={
          selection === null ? (
            <Button onClick={() => setOpen(false)} theme="outlined" variant="secondary">
              Zavřít
            </Button>
          ) : (
            <>
              <Button onClick={backToList} theme="outlined" variant="secondary">
                Zpět
              </Button>
              <Button isLoading={busy} loadingText="Ukládám…" onClick={save} variant="primary">
                Uložit
              </Button>
            </>
          )
        }
        onOpenChange={setOpen}
        open={open}
        resizeLabel={t('merchandise.sidePanel.resize')}
        size="md"
        title="Kategorie e-shopu"
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
          {listState.visible && (
            <>
              <FormInput
                id="category-admin-search"
                label="Hledat kategorii"
                name="categorySearch"
                onChange={(event) => setSearch(event.target.value)}
                placeholder="název nebo adresa"
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
                      <span
                        className="block w-full text-left"
                        style={{ textAlign: 'left' }}
                      >{`${c.name} · /${c.slug} · pořadí ${c.position}${c.published === false ? ' · Skryto' : ' · Zveřejněno'}`}</span>
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
          <CategoryEditor
            draft={draft}
            nameInvalid={nameInvalid}
            parentName={parentName}
            patchDraft={patchDraft}
            positionInvalid={positionInvalid}
            selected={selected}
            serverError={serverError}
            siblings={siblings}
          />
        </div>
      </SidePanel>
    </>
  );
};
