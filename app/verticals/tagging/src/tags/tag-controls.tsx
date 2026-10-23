/**
 * Shared tag controls for list pages in other verticals. Import from `@app/tagging/components/tag-controls`.
 *
 * Props-driven. The tag catalog is one shared page dataset (`tagCatalogData`), so every picker on a page and the
 * tagging page itself read the same tags; a page that offers pickers adds `preloadTagCatalog` to its `preloadPage`,
 * and the pickers open with their options in the first render. Loading, error and empty states stay inline.
 *
 * - `TagFilter({ kind, label?, catalog?, value, onChange })`: single-tag Combobox filter for subjects of `kind`.
 *   `value` is a `TagId` or `null`; `onChange` receives the same shape. Pass `label` when sibling filters show one,
 *   and `catalog` when the page already loaded the tags of the kind; without it the filter reads the shared catalog.
 * - `preloadTagCatalog`: an Effect that fills the shared catalog; add `() => preloadTagCatalog` to a page's
 *   `modulePagePreload`, so its pickers open with their options before the Shell reveals the page.
 * - `TagCell({ tags, loading })`: the tags of one row as chips, two at most, then `+N`. Pass `loading`
 *   while `useTagsFor` is still loading, so an empty cell never reads as "no tags".
 * - `useTagsFor(kind, ids)`: `{ canWrite, tagsBySubject, status, refetch }` for the rows of a list.
 *   `tagsBySubject` maps each subject id to its tags; `status` is `loading`, `ready` or `error`; `refetch` reloads;
 *   `canWrite` says whether the role may change tags.
 * - `useTagsOfKind(kind)`: the same for every subject of `kind`, read on mount without waiting for the list ids,
 *   plus a `catalog` to hand to `TagFilter`.
 * - `BulkTagDialog({ kind, subjectIds, open, onOpenChange, onDone })`: adds or removes one tag on many
 *   subjects. Confirms with a toast, so the host page must render one `<Toaster />` from
 *   `@techsio/ui-kit/molecules/toast`.
 */
import { matchesSearch, SidePanel, TagBadge, comboboxTranslations } from '@app/admin-ui';
import type { SidePanelSize } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Skeleton } from '@techsio/ui-kit/atoms/skeleton';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Combobox } from '@techsio/ui-kit/molecules/combobox';
import { RadioGroup } from '@techsio/ui-kit/molecules/radio-group';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { definePageData, pageDataPending } from '@app/shared-contracts/page-data';
import { Effect, Schema } from 'effect';
import type { ReactNode } from 'react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { assignTag, listTags, recordsFor, recordsOfKind, unassignTag } from '../api/records-client.ts';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import { ApplyCommandActionForbiddenProblemSchema } from '../../shared/apis/apply-command-action.ts';
import { RecordsForbiddenProblemSchema } from '../../shared/apis/records.ts';
import type { Assignment, Subject, SubjectId, SubjectKind, Tag, TagColor, TagId } from '../../shared/apis/records.ts';
import csResource from '../../locales/cs/tagging.json';
import enResource from '../../locales/en/tagging.json';

/** Resources for the tagging namespace. Pages and shared controls both wrap their copy in this boundary. */
export const taggingI18nResources = {
  cs: { tagging: csResource },
  en: { tagging: enResource },
} as const;

export const TagI18n = ({ children }: { children: ReactNode }) => (
  <FederatedI18nBoundary
    defaultNamespace="tagging"
    fallbackLanguage="en"
    resources={taggingI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    {children}
  </FederatedI18nBoundary>
);

/** Hex values behind the stored colour names. The UI shows the dot; the name is what is stored. */
export const tagColorValue = {
  blue: '#2563eb',
  gray: '#6b7280',
  green: '#16a34a',
  orange: '#ea580c',
  pink: '#db2777',
  purple: '#9333ea',
  red: '#dc2626',
  yellow: '#ca8a04',
} satisfies Record<TagColor, string>;

const tagsStatusValues = Schema.Literals(['loading', 'ready', 'error']);
export type TagsStatus = typeof tagsStatusValues.Type;

const bulkModeValues = Schema.Literals(['add', 'remove']);
export type BulkMode = typeof bulkModeValues.Type;

/** Runs a tagging client Effect in the browser runtime. Exactly one handler runs when it settles. */
export const runTagEffect = <A, E>(
  effect: Effect.Effect<A, E>,
  handlers: { readonly onFailure: (error: E) => void; readonly onSuccess: (value: A) => void },
) => {
  void browserRuntime.runPromise(effect.pipe(Effect.match(handlers)));
};

/** The tags of one row: two chips, then a muted `+N` for the rest. A skeleton while the row's tags still load. */
export const TagCell = ({ loading = false, tags }: { loading?: boolean; tags: readonly Tag[] }) => {
  if (loading && tags.length === 0) {
    return <Skeleton.Text className="w-20" lastLineWidth="100%" noOfLines={1} size="sm" />;
  }
  const visible = tags.slice(0, 2);
  const hiddenCount = tags.length - visible.length;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-50">
      {visible.map((tag) => (
        <TagBadge color={tagColorValue[tag.color]} key={tag.id} name={tag.name} />
      ))}
      {hiddenCount > 0 && <span className="text-fg-secondary text-xs tabular-nums">{`+${hiddenCount}`}</span>}
    </span>
  );
};

/** One catalog entry per document: a legal-entity or tenant switch reloads the document. */
const catalogScope = 'all';
type CatalogScope = typeof catalogScope;

/**
 * Every tag of the selected legal entity with its tag-wide counts. The tagging page and every picker read this one
 * dataset, so a page that preloaded it shows its options at once and a second picker issues no read of its own.
 */
export const tagCatalogData = definePageData({
  key: (scope: CatalogScope) => scope,
  load: () => listTags.pipe(Effect.map((tags) => [...tags])),
  runtime: browserRuntime,
});

/** Fills the shared tag catalog; a page adds `() => preloadTagCatalog` to its `modulePagePreload`. Never fails. */
export const preloadTagCatalog = tagCatalogData.preload(catalogScope);

/** Re-reads the catalog while the current tags stay on screen. Use after a tag write and for a retry. */
export const refreshTagCatalog = () => {
  browserRuntime.runFork(tagCatalogData.refresh(catalogScope));
};

type TagCatalogSnapshot = ReturnType<typeof tagCatalogData.snapshot>;
const catalogServerSnapshot = (): TagCatalogSnapshot => pageDataPending;
const readCatalog = () => tagCatalogData.snapshot(catalogScope);

/** The shared catalog, read synchronously. While `enabled`, a mount starts the read if nothing preloaded it. */
export const useTagCatalogSnapshot = (enabled: boolean): TagCatalogSnapshot => {
  const snapshot = useSyncExternalStore(tagCatalogData.subscribe, readCatalog, catalogServerSnapshot);
  useEffect(() => {
    if (enabled) {
      tagCatalogData.ensure(catalogScope);
    }
  }, [enabled]);
  return snapshot;
};

/** A failed read that is being retried shows as loading; the error comes back only if the retry fails too. */
export const tagCatalogStatusOf = (snapshot: TagCatalogSnapshot): TagsStatus => {
  if (snapshot.state === 'ready') {
    return 'ready';
  }
  return snapshot.state === 'failed' && !snapshot.refreshing ? 'error' : 'loading';
};

/** The shared catalog narrowed to the tags that apply to `kind`. */
const useTagCatalog = (kind: SubjectKind, enabled: boolean): TagCatalog => {
  const snapshot = useTagCatalogSnapshot(enabled);
  const tags = snapshot.state === 'ready' ? snapshot.value.filter((tag) => tag.subjectKinds.includes(kind)) : [];
  return { refetch: refreshTagCatalog, status: tagCatalogStatusOf(snapshot), tags };
};

/** Tags a picker offers, loaded by the picker itself or handed in by a page that already read them. */
export interface TagCatalog {
  readonly refetch: () => void;
  readonly status: TagsStatus;
  readonly tags: readonly Tag[];
}

/** Maps a Combobox value back to a loaded tag. Anything outside the loaded catalog counts as no selection. */
const pickTagId = (tags: readonly Tag[], next: string | string[]): TagId | null => {
  const id = Array.isArray(next) ? next[0] : next;
  return tags.find((tag) => tag.id === id)?.id ?? null;
};

/** Value of the filter's "all tags" option. It is not a tag id, so `pickTagId` maps it to no selection. */
const allTagsValue = '__all_tags__';

const tagItems = (tags: readonly Tag[], allLabel: string | null) => [
  ...(allLabel === null ? [] : [{ id: allTagsValue, label: allLabel, value: allTagsValue }]),
  ...tags.map((tag) => ({ id: tag.id, label: tag.name, value: tag.id })),
];

/**
 * Options for the typed text, ignoring case and diacritics (`velka` finds `Velká zakázka`). After a pick the input
 * shows that option's label, so text equal to a label lists every option again instead of only the picked one.
 */
const visibleTagItems = <T extends { readonly label: string }>(items: readonly T[], query: string): T[] =>
  items.some((item) => item.label === query) ? [...items] : items.filter((item) => matchesSearch(item.label, query));

interface TagPickerFieldProps {
  /** Tags the caller already loaded. Without it the picker reads the shared catalog. A retry calls `refetch`. */
  readonly catalog?: TagCatalog;
  readonly clearable: boolean;
  /** Filter mode: small control and a leading "all tags" option. A label shows only when the caller passes one. */
  readonly compact?: boolean;
  readonly enabled: boolean;
  /** Empty string when there is no message. */
  readonly helpText: string;
  /** DOM id of the Combobox. Its input is `combobox:<id>:input`, so a panel can name it as its first field. */
  readonly id?: string;
  readonly invalid: boolean;
  readonly kind: SubjectKind;
  /** Visible label already translated by the caller. Wins over `labelKey`. */
  readonly label?: string;
  readonly labelKey?: string;
  readonly onChange: (tagId: TagId | null) => void;
  readonly value: TagId | null;
}

const TagPickerField = ({
  catalog: provided,
  clearable,
  compact = false,
  enabled,
  helpText,
  id,
  invalid,
  kind,
  label,
  labelKey,
  onChange,
  value,
}: TagPickerFieldProps) => {
  const { t } = useModernI18n();
  const own = useTagCatalog(kind, enabled && provided === undefined);
  const catalog = provided ?? own;
  const [open, setOpen] = useState(false);
  /** Text typed while the list is open. `null` once it closes. */
  const [typed, setTyped] = useState<string | null>(null);
  const items = tagItems(catalog.tags, compact ? t('tagging.tags.filter.all') : null);
  const fieldLabel = label ?? (labelKey === undefined ? undefined : t(labelKey));
  const appliedName = catalog.tags.find((tag) => tag.id === value)?.name ?? '';
  // A closed field always shows the applied tag, so text typed before Escape or a blur never outlives the list.
  const query = open ? (typed ?? appliedName) : appliedName;
  return (
    <Combobox
      clearable={clearable}
      error={catalog.status === 'error' ? t('tagging.tags.loadFailed') : undefined}
      {...(id === undefined ? {} : { id })}
      // ui-kit's local filter matches accents exactly, so the picker filters the options itself.
      filterBehavior="external"
      helpText={helpText}
      inputValue={query}
      items={visibleTagItems(items, query)}
      {...(fieldLabel === undefined ? {} : { label: fieldLabel })}
      loading={catalog.status === 'loading'}
      loadingMessage={t('tagging.tags.loading')}
      noResultsMessage={t('tagging.tags.filter.noResults')}
      onChange={(next) => onChange(pickTagId(catalog.tags, next))}
      onInputValueChange={(text) => {
        setTyped(text);
        // Emptying a filter's text clears the filter; zag restores a picked label on blur, never an empty one.
        if (compact && value !== null && text.trim() === '') {
          onChange(null);
        }
      }}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setTyped(null);
        }
      }}
      onRetry={() => catalog.refetch()}
      open={open}
      openOnClick
      // A filter with no tag applied reads "all tags", the same text its "all" option sets, so the placeholder never changes.
      placeholder={compact ? t('tagging.tags.filter.all') : t('tagging.tags.filter.placeholder')}
      retryLabel={t('tagging.tags.retry')}
      size="sm"
      translations={{
        clearTriggerLabel: comboboxTranslations.clearTriggerLabel,
        triggerLabel: t('tagging.tags.filter.toggle'),
      }}
      validateStatus={invalid ? 'error' : 'default'}
      value={value === null ? [] : [value]}
    />
  );
};

const TagPicker = (props: TagPickerFieldProps) => (
  <TagI18n>
    <TagPickerField {...props} />
  </TagI18n>
);

export interface TagFilterProps {
  /** Tags the page already loaded, for example `useTagsOfKind(kind).catalog`. Without it the filter reads the shared catalog. */
  catalog?: TagCatalog;
  kind: SubjectKind;
  /** Visible label above the filter, already translated. Pages pass one when sibling filters have labels. */
  label?: string;
  onChange: (tagId: TagId | null) => void;
  value: TagId | null;
}

/** Single-tag filter for a list of subjects of one kind. Only tags that apply to `kind` are offered. */
export const TagFilter = ({ catalog, kind, label, onChange, value }: TagFilterProps) => (
  // The Combobox root gaps its label wider than a Select root does (6 px against 4 px). Beside Selects in a filter row,
  // that lifts the label, so the picker takes the Select gap.
  <div className="w-48 *:gap-(--spacing-select)">
    {/* The "all tags" option clears the filter, so the picker needs no clear button. */}
    <TagPicker
      {...(catalog === undefined ? {} : { catalog })}
      clearable={false}
      compact
      enabled
      helpText=""
      invalid={false}
      kind={kind}
      {...(label === undefined ? {} : { label })}
      onChange={onChange}
      value={value}
    />
  </div>
);

/** Groups the assignments of one records read by subject, resolving each tag id against the tags of that read. */
const tagsBySubjectOf = (records: {
  readonly assignments: readonly Assignment[];
  readonly tags: readonly Tag[];
}): ReadonlyMap<SubjectId, Tag[]> => {
  const tagById = new Map(records.tags.map((tag) => [tag.id, tag] as const));
  const next = new Map<SubjectId, Tag[]>();
  for (const assignment of records.assignments) {
    const tag = tagById.get(assignment.tagId);
    if (tag !== undefined) {
      next.set(assignment.subject.id, [...(next.get(assignment.subject.id) ?? []), tag]);
    }
  }
  return next;
};

interface TagsRequest {
  readonly kind: SubjectKind;
  readonly subjectIds: readonly SubjectId[];
  readonly subjectKey: string;
}

/**
 * Tags for the given subjects, keyed by subject id. Failures set `status` to `error`; they never read as no tags.
 * `canWrite` is the records read's `demo.tagging.write_all` answer, so a page can hide tag edits from a read-only role
 * without a refused command. It stays `undefined` until a read succeeds.
 */
export const useTagsFor = (kind: SubjectKind, ids: readonly SubjectId[]) => {
  const subjectKey = ids.join(',');
  const [request, setRequest] = useState<TagsRequest>({ kind, subjectIds: ids, subjectKey });
  const [status, setStatus] = useState<TagsStatus>('loading');
  const [canWrite, setCanWrite] = useState<boolean>();
  const [tagsBySubject, setTagsBySubject] = useState<ReadonlyMap<SubjectId, Tag[]>>(new Map());
  // A new kind or new subject ids start a new request; the previous rows stay until the new ones arrive.
  if (request.kind !== kind || request.subjectKey !== subjectKey) {
    setRequest({ kind, subjectIds: ids, subjectKey });
  }
  useEffect(() => {
    let active = true;
    // One records read carries both the tag catalog and the assignments, so a list costs one operation.
    if (request.subjectIds.length > 0) {
      runTagEffect(recordsFor(request.kind, request.subjectIds), {
        onFailure: () => {
          if (active) {
            setStatus('error');
            setTagsBySubject(new Map());
          }
        },
        onSuccess: (records) => {
          if (!active) {
            return;
          }
          setStatus('ready');
          setCanWrite(records.canWrite);
          setTagsBySubject(tagsBySubjectOf(records));
        },
      });
    }
    return () => {
      active = false;
    };
  }, [request]);
  const refetch = () => setRequest((current) => ({ ...current }));
  // An empty list has nothing to load, so it is ready at once and never issues a read.
  return { canWrite, refetch, status: request.subjectIds.length === 0 ? 'ready' : status, tagsBySubject };
};

/** What `useTagsOfKind` returns: the tags of every subject of one kind, plus the tags that apply to that kind. */
export interface KindTags {
  /** Tags that apply to the kind, for a `TagFilter` that should not read the catalog again. */
  readonly catalog: TagCatalog;
  readonly refetch: () => void;
  readonly status: TagsStatus;
  readonly tagsBySubject: ReadonlyMap<SubjectId, Tag[]>;
}

/**
 * Tags of every subject of `kind`, read once on mount. Unlike `useTagsFor` it does not wait for the list's ids, so a
 * page can start it next to its own list read and both settle together. Use it where the list shows every subject of
 * the kind (small catalogs such as employees); rows look their tags up in `tagsBySubject`.
 */
export const useTagsOfKind = (kind: SubjectKind): KindTags => {
  // A new object starts a new read, so a refetch re-runs the effect without a counter it would not read.
  const [request, setRequest] = useState<{ readonly kind: SubjectKind }>({ kind });
  const [state, setState] = useState<{
    readonly catalog: readonly Tag[];
    readonly status: TagsStatus;
    readonly tagsBySubject: ReadonlyMap<SubjectId, Tag[]>;
  }>({ catalog: [], status: 'loading', tagsBySubject: new Map() });
  if (request.kind !== kind) {
    setRequest({ kind });
  }
  useEffect(() => {
    let active = true;
    // One records read narrowed to the kind carries the tag catalog and every assignment of that kind.
    runTagEffect(recordsOfKind(request.kind), {
      onFailure: () => {
        if (active) {
          setState({ catalog: [], status: 'error', tagsBySubject: new Map() });
        }
      },
      onSuccess: (records) => {
        if (active) {
          setState({
            catalog: records.tags.filter((tag) => tag.subjectKinds.includes(request.kind)),
            status: 'ready',
            tagsBySubject: tagsBySubjectOf(records),
          });
        }
      },
    });
    return () => {
      active = false;
    };
  }, [request]);
  // A refetch keeps the current tags on screen until the new read settles.
  const refetch = () => setRequest((current) => ({ ...current }));
  return {
    catalog: { refetch, status: state.status, tags: state.catalog },
    refetch,
    status: state.status,
    tagsBySubject: state.tagsBySubject,
  };
};

const subjectChunkSize = 500;

export interface BulkTagDialogProps {
  kind: SubjectKind;
  onDone: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  /** Panel width; defaults to `md`. Pages whose other panels are wider pass their size. */
  size?: SidePanelSize;
  subjectIds: readonly SubjectId[];
}

const bulkFailureValues = Schema.Literals(['none', 'retry', 'forbidden']);
type BulkFailure = typeof bulkFailureValues.Type;

/** A 403 from the records read or the apply command: retrying will not help, so the panel says so. */
const isForbidden = Schema.is(Schema.Union([RecordsForbiddenProblemSchema, ApplyCommandActionForbiddenProblemSchema]));

const BulkTagDialogContent = ({ kind, onDone, onOpenChange, open, size = 'md', subjectIds }: BulkTagDialogProps) => {
  const { t } = useModernI18n();
  const toaster = useToast();
  const [tagId, setTagId] = useState<TagId | null>(null);
  const [mode, setMode] = useState<BulkMode>('add');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<BulkFailure>('none');
  const [submitted, setSubmitted] = useState(false);
  // The picker reads the same shared catalog; a 403 on it means this role may not tag at all, so the panel says so.
  const catalog = useTagCatalogSnapshot(open);
  const catalogForbidden = catalog.state === 'failed' && isForbidden(catalog.error);
  const forbidden = catalogForbidden || failure === 'forbidden';

  const close = () => {
    setTagId(null);
    setMode('add');
    setFailure('none');
    setSubmitted(false);
    onOpenChange(false);
  };

  const submit = () => {
    setSubmitted(true);
    if (tagId === null || subjectIds.length === 0) {
      return;
    }
    const operation = mode === 'add' ? assignTag : unassignTag;
    const subjects: Subject[] = subjectIds.map((id) => ({ id, kind }));
    const chunks = Array.from({ length: Math.ceil(subjects.length / subjectChunkSize) }, (_, index) =>
      subjects.slice(index * subjectChunkSize, (index + 1) * subjectChunkSize),
    );
    setBusy(true);
    setFailure('none');
    runTagEffect(
      Effect.forEach(chunks, (part) => operation(tagId, part), { concurrency: 1, discard: true }),
      {
        onFailure: (error) => {
          setBusy(false);
          setFailure(isForbidden(error) ? 'forbidden' : 'retry');
        },
        onSuccess: () => {
          setBusy(false);
          toaster.create({ title: t('tagging.tags.bulk.success'), type: 'success' });
          onDone();
          close();
        },
      },
    );
  };

  const tagError = submitted && tagId === null;
  return (
    <SidePanel
      actions={
        <>
          <Button disabled={busy} onClick={() => close()} size="sm" theme="outlined" variant="secondary">
            {t('tagging.tags.form.cancel')}
          </Button>
          <Button
            disabled={subjectIds.length === 0 || forbidden}
            isLoading={busy}
            loadingText={t('tagging.tags.bulk.busy')}
            onClick={() => submit()}
            size="sm"
            variant="primary"
          >
            {t(mode === 'remove' ? 'tagging.tags.bulk.submitRemove' : 'tagging.tags.bulk.submit')}
          </Button>
        </>
      }
      // The picked tag and mode are a draft; Escape, the close button and Zrušit close the panel.
      closeOnInteractOutside={false}
      description={t('tagging.tags.bulk.description', { total: subjectIds.length })}
      // The first field takes focus, not the close button the panel renders first.
      initialFocusEl={() => globalThis.document.querySelector<HTMLElement>('[id="combobox:bulk-tag-picker:input"]')}
      onOpenChange={(next) => {
        if (!next && !busy) {
          close();
        }
      }}
      open={open}
      resizeLabel={t('tagging.sidePanel.resize')}
      size={size}
      title={t('tagging.tags.bulk.title')}
    >
      <div className="flex flex-col gap-200 py-200">
        {forbidden && (
          <StatusText showIcon status="error">
            {t('tagging.tags.bulk.forbidden')}
          </StatusText>
        )}
        {!forbidden && failure === 'retry' && (
          <StatusText showIcon status="error">
            {t('tagging.tags.bulk.failure')}
          </StatusText>
        )}
        {!forbidden && (
          <TagPicker
            clearable={false}
            enabled={open}
            helpText={tagError ? t('tagging.tags.bulk.chooseTag') : ''}
            id="bulk-tag-picker"
            invalid={tagError}
            kind={kind}
            labelKey="tagging.tags.bulk.tag"
            onChange={setTagId}
            value={tagId}
          />
        )}
        <RadioGroup
          disabled={forbidden}
          onValueChange={(next) => setMode(next === 'remove' ? 'remove' : 'add')}
          size="sm"
          value={mode}
        >
          <RadioGroup.Label>{t('tagging.tags.bulk.action')}</RadioGroup.Label>
          <RadioGroup.ItemGroup>
            <RadioGroup.Item value="add">
              <RadioGroup.ItemHiddenInput />
              <RadioGroup.ItemControl />
              <RadioGroup.ItemText>{t('tagging.tags.bulk.add')}</RadioGroup.ItemText>
            </RadioGroup.Item>
            <RadioGroup.Item value="remove">
              <RadioGroup.ItemHiddenInput />
              <RadioGroup.ItemControl />
              <RadioGroup.ItemText>{t('tagging.tags.bulk.remove')}</RadioGroup.ItemText>
            </RadioGroup.Item>
          </RadioGroup.ItemGroup>
        </RadioGroup>
      </div>
    </SidePanel>
  );
};

/** Adds or removes one tag on the selected subjects. Idempotent on the server: rows already in that state are skipped. */
export const BulkTagDialog = (props: BulkTagDialogProps) => (
  <TagI18n>
    <BulkTagDialogContent {...props} />
  </TagI18n>
);
