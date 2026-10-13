/**
 * Shared tag controls for list pages in other verticals. Import from `@app/tagging/components/tag-controls`.
 *
 * Props-driven, no global state. Each control loads its own data through the tagging client and shows
 * loading, error and empty states inline.
 *
 * - `TagFilter({ kind, value, onChange })`: single-tag Combobox filter for subjects of `kind`.
 *   `value` is a `TagId` or `null`; `onChange` receives the same shape.
 * - `TagCell({ tags })`: the tags of one row as chips, three at most, then `+N`.
 * - `useTagsFor(kind, ids)`: `{ tagsBySubject, status, refetch }` for the rows of a list. `tagsBySubject`
 *   maps each subject id to its tags; `status` is `loading`, `ready` or `error`; `refetch` reloads.
 * - `BulkTagDialog({ kind, subjectIds, open, onOpenChange, onDone })`: adds or removes one tag on many
 *   subjects. Confirms with a toast, so the host page must render one `<Toaster />` from
 *   `@techsio/ui-kit/molecules/toast`.
 */
import { TagBadge } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Combobox } from '@techsio/ui-kit/molecules/combobox';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { RadioGroup } from '@techsio/ui-kit/molecules/radio-group';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Effect, Schema } from 'effect';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { assignmentsFor, assignTag, listTags, unassignTag } from '../api/records-client.ts';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import type { Subject, SubjectId, SubjectKind, Tag, TagColor, TagId } from '../../shared/apis/records.ts';
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

/** The tags of one row: two chips, then a muted `+N` for the rest. */
export const TagCell = ({ tags }: { tags: readonly Tag[] }) => {
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

/** Loads every tag that applies to `kind`. Does nothing while `enabled` is false. */
const useTagCatalog = (kind: SubjectKind, enabled: boolean) => {
  const [state, setState] = useState<{ readonly status: TagsStatus; readonly tags: Tag[] }>({
    status: 'loading',
    tags: [],
  });
  useEffect(() => {
    let active = true;
    if (enabled) {
      runTagEffect(listTags, {
        onFailure: () => {
          if (active) {
            setState({ status: 'error', tags: [] });
          }
        },
        onSuccess: (tags) => {
          if (active) {
            setState({ status: 'ready', tags: tags.filter((tag) => tag.subjectKinds.includes(kind)) });
          }
        },
      });
    }
    return () => {
      active = false;
    };
  }, [enabled, kind]);
  return state;
};

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

interface TagPickerFieldProps {
  readonly clearable: boolean;
  /** Filter mode: small control, no visible label, and a leading "all tags" option. */
  readonly compact?: boolean;
  readonly enabled: boolean;
  /** Empty string when there is no message. */
  readonly helpText: string;
  readonly invalid: boolean;
  readonly kind: SubjectKind;
  readonly labelKey?: string;
  readonly onChange: (tagId: TagId | null) => void;
  readonly onRetry: () => void;
  readonly value: TagId | null;
}

const TagPickerField = ({
  clearable,
  compact = false,
  enabled,
  helpText,
  invalid,
  kind,
  labelKey,
  onChange,
  onRetry,
  value,
}: TagPickerFieldProps) => {
  const { t } = useModernI18n();
  const catalog = useTagCatalog(kind, enabled);
  return (
    <Combobox
      clearable={clearable}
      error={catalog.status === 'error' ? t('tagging.tags.loadFailed') : undefined}
      helpText={helpText}
      items={tagItems(catalog.tags, compact ? t('tagging.tags.filter.all') : null)}
      {...(labelKey === undefined ? {} : { label: t(labelKey) })}
      loading={catalog.status === 'loading'}
      noResultsMessage={t('tagging.tags.filter.noResults')}
      onChange={(next) => onChange(pickTagId(catalog.tags, next))}
      onRetry={() => onRetry()}
      placeholder={t('tagging.tags.filter.placeholder')}
      retryLabel={t('tagging.tags.retry')}
      size={compact ? 'sm' : 'md'}
      validateStatus={invalid ? 'error' : 'default'}
      value={value === null ? [] : [value]}
    />
  );
};

/** Combobox that loads its own catalog. A retry remounts it, so the catalog loads again. */
const TagPicker = (props: Omit<TagPickerFieldProps, 'onRetry'>) => {
  const [attempt, setAttempt] = useState(0);
  return (
    <TagI18n>
      <TagPickerField {...props} key={attempt} onRetry={() => setAttempt((current) => current + 1)} />
    </TagI18n>
  );
};

export interface TagFilterProps {
  kind: SubjectKind;
  onChange: (tagId: TagId | null) => void;
  value: TagId | null;
}

/** Single-tag filter for a list of subjects of one kind. Only tags that apply to `kind` are offered. */
export const TagFilter = ({ kind, onChange, value }: TagFilterProps) => (
  <div className="w-48">
    <TagPicker clearable compact enabled helpText="" invalid={false} kind={kind} onChange={onChange} value={value} />
  </div>
);

interface TagsRequest {
  readonly kind: SubjectKind;
  readonly subjectIds: readonly SubjectId[];
  readonly subjectKey: string;
}

/** Tags for the given subjects, keyed by subject id. Failures set `status` to `error`; they never read as no tags. */
export const useTagsFor = (kind: SubjectKind, ids: readonly SubjectId[]) => {
  const subjectKey = ids.join(',');
  const [request, setRequest] = useState<TagsRequest>({ kind, subjectIds: ids, subjectKey });
  const [status, setStatus] = useState<TagsStatus>('loading');
  const [tagsBySubject, setTagsBySubject] = useState<ReadonlyMap<SubjectId, Tag[]>>(new Map());
  // A new kind or new subject ids start a new request; the previous rows stay until the new ones arrive.
  if (request.kind !== kind || request.subjectKey !== subjectKey) {
    setRequest({ kind, subjectIds: ids, subjectKey });
  }
  useEffect(() => {
    let active = true;
    runTagEffect(Effect.all([listTags, assignmentsFor(request.kind, request.subjectIds)], { concurrency: 1 }), {
      onFailure: () => {
        if (active) {
          setStatus('error');
          setTagsBySubject(new Map());
        }
      },
      onSuccess: ([tags, assignments]) => {
        if (!active) {
          return;
        }
        const tagById = new Map(tags.map((tag) => [tag.id, tag] as const));
        const next = new Map<SubjectId, Tag[]>();
        for (const assignment of assignments) {
          const tag = tagById.get(assignment.tagId);
          if (tag !== undefined) {
            next.set(assignment.subject.id, [...(next.get(assignment.subject.id) ?? []), tag]);
          }
        }
        setStatus('ready');
        setTagsBySubject(next);
      },
    });
    return () => {
      active = false;
    };
  }, [request]);
  const refetch = () => setRequest((current) => ({ ...current }));
  return { refetch, status, tagsBySubject };
};

const subjectChunkSize = 500;

export interface BulkTagDialogProps {
  kind: SubjectKind;
  onDone: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  subjectIds: readonly SubjectId[];
}

const BulkTagDialogContent = ({ kind, onDone, onOpenChange, open, subjectIds }: BulkTagDialogProps) => {
  const { t } = useModernI18n();
  const toaster = useToast();
  const [tagId, setTagId] = useState<TagId | null>(null);
  const [mode, setMode] = useState<BulkMode>('add');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const close = () => {
    setTagId(null);
    setMode('add');
    setFailed(false);
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
    setFailed(false);
    runTagEffect(
      Effect.forEach(chunks, (part) => operation(tagId, part), { concurrency: 1, discard: true }),
      {
        onFailure: () => {
          setBusy(false);
          setFailed(true);
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
    <Dialog
      actions={
        <>
          <Button onClick={() => close()} theme="outlined" variant="secondary">
            {t('tagging.tags.form.cancel')}
          </Button>
          <Button
            disabled={subjectIds.length === 0}
            isLoading={busy}
            loadingText={t('tagging.tags.bulk.busy')}
            onClick={() => submit()}
            variant="primary"
          >
            {t('tagging.tags.bulk.submit')}
          </Button>
        </>
      }
      description={t('tagging.tags.bulk.description', { total: subjectIds.length })}
      onOpenChange={(details) => {
        if (!details.open) {
          close();
        }
      }}
      open={open}
      placement="right"
      size="sm"
      title={t('tagging.tags.bulk.title')}
    >
      <div className="flex flex-col gap-200 py-200">
        {failed && (
          <StatusText showIcon status="error">
            {t('tagging.tags.bulk.failure')}
          </StatusText>
        )}
        <TagPicker
          clearable={false}
          enabled={open}
          helpText={tagError ? t('tagging.tags.bulk.chooseTag') : ''}
          invalid={tagError}
          kind={kind}
          labelKey="tagging.tags.bulk.tag"
          onChange={setTagId}
          value={tagId}
        />
        <RadioGroup onValueChange={(next) => setMode(next === 'remove' ? 'remove' : 'add')} value={mode}>
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
    </Dialog>
  );
};

/** Adds or removes one tag on the selected subjects. Idempotent on the server: rows already in that state are skipped. */
export const BulkTagDialog = (props: BulkTagDialogProps) => (
  <TagI18n>
    <BulkTagDialogContent {...props} />
  </TagI18n>
);
