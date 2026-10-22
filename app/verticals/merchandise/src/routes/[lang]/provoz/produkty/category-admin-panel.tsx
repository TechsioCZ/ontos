import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Switch } from '@techsio/ui-kit/molecules/switch';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { SidePanel, formatDateTime } from '@app/admin-ui';
import { DateTime } from 'effect';
import { useMemo, useState } from 'react';
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
  readonly published: boolean;
  readonly name: string;
  readonly heading: string;
  readonly description: string;
  readonly longDescription: string;
  readonly positionText: string;
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

interface CategoryAdminButtonProps {
  readonly onCommitted: (message: string) => void;
}

/** Side panel for the storefront category tree: rename, heading, descriptions and sibling order. */
export const CategoryAdminButton = ({ onCommitted }: CategoryAdminButtonProps) => {
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
  const parentId = selected?.parentId ?? null;
  const parentName = parentId === null ? undefined : categories.find((c) => c.id === parentId)?.name;
  // Siblings in storefront order, so the editor can see where a position puts the category.
  const siblings = useMemo(
    () =>
      selected === undefined
        ? NO_CATEGORIES
        : categories.filter((c) => c.parentId === parentId && c.id !== selected.id).toSorted(byStorefrontOrder),
    [categories, parentId, selected],
  );

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

  const list = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase('cs');
    const matches =
      needle === ''
        ? categories.filter((c) => c.parentId === null).toSorted(byStorefrontOrder)
        : categories
            .filter((c) => c.name.toLocaleLowerCase('cs').includes(needle) || c.slug.includes(needle))
            .toSorted(byStorefrontOrder);
    return matches.slice(0, 40);
  }, [categories, search]);

  const patchDraft = (patch: Partial<CategoryDraft>) =>
    setDraft((current) => (current === null ? current : { ...current, ...patch }));

  const position = Number(draft?.positionText ?? '');
  const positionInvalid =
    draft !== null && (draft.positionText.trim() === '' || !Number.isInteger(position) || position < 0);
  const nameInvalid = draft !== null && (draft.name.trim() === '' || draft.name.trim().length > 200);

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
          name: draft.name.trim(),
          heading: draft.heading.trim(),
          description: draft.description.trim(),
          longDescription: draft.longDescription.trim(),
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
          {(loaded.status === 'idle' || loaded.status === 'loading') && <StatusText>Načítám kategorie…</StatusText>}
          {loaded.status === 'error' && (
            <>
              <StatusText showIcon status="error">
                Kategorie se nepodařilo načíst.
              </StatusText>
              <Button onClick={reload} variant="secondary">
                Zkusit znovu
              </Button>
            </>
          )}
          {loaded.status === 'ready' && categories.length === 0 && (
            <p className="text-fg-secondary text-sm">Tato firma nemá kategorie e-shopu.</p>
          )}
          {loaded.status === 'ready' && categories.length > 0 && selection === null && (
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
                      onClick={() => select(c.id)}
                      className="h-auto w-full justify-start whitespace-normal text-left"
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
          {selected !== undefined && draft !== null && (
            <>
              <p className="text-fg-secondary text-sm">
                {`Adresa v e-shopu: /${selected.slug}${parentName === undefined ? '' : ` · nadřazená kategorie: ${parentName}`}`}
              </p>
              <Switch
                name="categoryPublished"
                checked={draft.published}
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
                {...(nameInvalid
                  ? { helpText: 'Zadejte název (nejvýše 200 znaků)', validateStatus: 'error' as const }
                  : {})}
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
                {...(positionInvalid
                  ? { helpText: 'Zadejte celé číslo 0 nebo větší', validateStatus: 'error' as const }
                  : {})}
              />
              {siblings.length > 0 && (
                <div className="flex flex-col gap-100">
                  <p className="text-fg-secondary text-sm">
                    {`Stejné pořadí řadí podle názvu. Mezi dvě kategorie ji dáte číslem mezi jejich pořadím. Sourozenci: ${siblings
                      .slice(0, 6)
                      .map((c) => `${c.name} (${c.position})`)
                      .join(', ')}${siblings.length > 6 ? ', …' : ''}`}
                  </p>
                  <div className="flex flex-wrap gap-100">
                    <Button
                      onClick={() =>
                        patchDraft({ positionText: String(Math.max(0, (siblings[0]?.position ?? 0) - 10)) })
                      }
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
          )}
        </div>
      </SidePanel>
    </>
  );
};
