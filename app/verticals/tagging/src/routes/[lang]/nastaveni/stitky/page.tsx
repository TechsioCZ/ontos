import {
  AutosaveStatus,
  EmptyState,
  PageHeader,
  SidePanel,
  TagBadge,
  Toaster,
  dialogCloseLabel,
  paginationTranslations,
  useAutosaveDraft,
} from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import type { ColumnDef } from '@techsio/ui-kit/organisms/data-table';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { modulePagePreload } from '@app/shared-contracts/page-data';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { Effect, Predicate, Schema } from 'effect';
import { useEffect, useRef, useState } from 'react';
import {
  applyTaggingCommand,
  applyTaggingCommandIfUnchanged,
  subjectsWithTag,
} from '../../../../api/records-consumer.ts';
import { loadSubjectNames } from '../../../../api/subject-names.ts';
import type { SubjectNames } from '../../../../api/subject-names.ts';
import {
  preloadTagCatalog,
  refreshTagCatalog,
  runTagEffect,
  TagI18n,
  tagCatalogStatusOf,
  tagColorValue,
  useTagCatalogSnapshot,
} from '../../../../tags/tag-controls.tsx';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { subjectKindValues, tagColorValues } from '../../../../../shared/apis/records.ts';
import type { SubjectId, SubjectKind, TagId, TagWithCounts } from '../../../../../shared/apis/records.ts';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import '../../../index.css';
import {
  createTagCommand,
  sameTagDraft,
  tagAutosaveResult,
  tagDraftOf,
  tagNameProblem,
  tagUnchangedSince,
  updateTagCommand,
  validTagDraft,
} from './tag-draft.ts';
import type { TagDraft } from './tag-draft.ts';

type Translate = ReturnType<typeof useModernI18n>['t'];

const noTags: TagWithCounts[] = [];
const newTagKey = 'tagging.tags.new';
const searchKey = 'tagging.tags.table.search';
const resizeKey = 'tagging.sidePanel.resize';

/** The kinds a tag applies to, in the canonical order. */
const kindsOf = (tag: TagWithCounts) => {
  const applies = new Set(tag.subjectKinds);
  return subjectKindValues.filter((kind) => applies.has(kind));
};

const toggleKind = (kinds: readonly SubjectKind[], kind: SubjectKind, checked: boolean) => {
  const selected = new Set(kinds);
  return subjectKindValues.filter((value) => (value === kind ? checked : selected.has(value)));
};

const CancelButton = ({ onClick }: { onClick: () => void }) => {
  const { t } = useModernI18n();
  return (
    <Button onClick={() => onClick()} theme="outlined" variant="secondary">
      {t('tagging.tags.form.cancel')}
    </Button>
  );
};

const nameErrorKey = {
  required: 'tagging.tags.form.nameRequired',
  tooLong: 'tagging.tags.form.nameTooLong',
} as const;

/** The fields of one tag, shared by the create dialog and the autosaving edit panel. */
const TagFields = ({
  draft,
  onBlur,
  onChange,
  showErrors,
}: {
  readonly draft: TagDraft;
  readonly onBlur: () => void;
  readonly onChange: (update: (current: TagDraft) => TagDraft) => void;
  /** Inline field errors are shown (after the first create attempt; always while editing). */
  readonly showErrors: boolean;
}) => {
  const { t } = useModernI18n();
  const nameProblem = tagNameProblem(draft);
  const showNameError = showErrors && nameProblem !== null;
  const showKindsError = showErrors && draft.kinds.length === 0;
  const selectedKinds = new Set(draft.kinds);
  const colorItems = tagColorValues.map((color) => ({
    label: (
      <span className="flex items-center gap-100">
        <span
          aria-hidden
          className="size-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: tagColorValue[color] }}
        />
        {t(`tagging.colors.${color}`)}
      </span>
    ),
    value: color,
  }));
  return (
    <>
      <FormInput
        autoComplete="off"
        helpText={nameProblem !== null && showNameError ? t(nameErrorKey[nameProblem]) : undefined}
        id="tag-name"
        label={t('tagging.tags.form.name')}
        name="name"
        onBlur={onBlur}
        onChange={(event) => {
          const { value } = event.target;
          onChange((current) => ({ ...current, name: value }));
        }}
        required
        validateStatus={showNameError ? 'error' : 'default'}
        value={draft.name}
      />
      <SelectTemplate
        items={colorItems}
        label={t('tagging.tags.form.color')}
        name="color"
        onValueChange={(details) => {
          const picked = tagColorValues.find((value) => value === details.value[0]);
          if (picked !== undefined) {
            onChange((current) => ({ ...current, color: picked }));
          }
        }}
        placeholder={t('tagging.tags.selectPlaceholder')}
        value={[draft.color]}
      />
      <FormTextarea
        autoComplete="off"
        id="tag-description"
        label={t('tagging.tags.form.description')}
        name="description"
        onBlur={onBlur}
        onChange={(event) => {
          const { value } = event.target;
          onChange((current) => ({ ...current, description: value }));
        }}
        value={draft.description}
      />
      <fieldset className="flex flex-col gap-100">
        <legend className="font-medium text-sm">{t('tagging.tags.form.kinds')}</legend>
        {subjectKindValues.map((kind) => (
          <FormCheckbox
            checked={selectedKinds.has(kind)}
            key={kind}
            name="kinds"
            onCheckedChange={(checked) =>
              onChange((current) => ({ ...current, kinds: toggleKind(current.kinds, kind, checked) }))
            }
            value={kind}
          >
            {t(`tagging.kinds.${kind}`)}
          </FormCheckbox>
        ))}
        {showKindsError && (
          <StatusText showIcon status="error">
            {t('tagging.tags.form.kindsRequired')}
          </StatusText>
        )}
      </fieldset>
    </>
  );
};

const noBlur = () => {
  // Creating saves only on "Vytvořit štítek".
};

/** Create a tag. Escape, the close button and Zrušit ask before they drop typed values. */
const TagCreateDialog = ({ onClose }: { onClose: () => void }) => {
  const { t } = useModernI18n();
  const toaster = useToast();
  const initial = tagDraftOf(null);
  const [draft, setDraft] = useState<TagDraft>(initial);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);

  const handleDraftChange = setDraft;
  const requestClose = () => {
    if (!sameTagDraft(draft, initial) && !busy) {
      setDiscardOpen(true);
      return;
    }
    onClose();
  };

  const submit = () => {
    setSubmitted(true);
    if (!validTagDraft(draft)) {
      return;
    }
    setBusy(true);
    setFailed(false);
    runTagEffect(applyTaggingCommand(createTagCommand(draft)), {
      onFailure: () => {
        setBusy(false);
        setFailed(true);
      },
      onSuccess: () => {
        setBusy(false);
        toaster.create({ title: t('tagging.tags.created'), type: 'success' });
        onClose();
      },
    });
  };

  return (
    <>
      <SidePanel
        actions={
          <>
            <CancelButton onClick={requestClose} />
            <Button
              isLoading={busy}
              loadingText={t('tagging.tags.form.saving')}
              onClick={() => submit()}
              variant="primary"
            >
              {t('tagging.tags.form.createSubmit')}
            </Button>
          </>
        }
        onOpenChange={(next) => {
          if (!next) {
            requestClose();
          }
        }}
        open
        resizeLabel={t(resizeKey)}
        size="md"
        title={t(newTagKey)}
      >
        <form
          className="flex flex-col gap-200 py-200"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {failed && (
            <StatusText showIcon status="error">
              {t('tagging.tags.failure')}
            </StatusText>
          )}
          <TagFields draft={draft} onBlur={noBlur} onChange={handleDraftChange} showErrors={submitted} />
        </form>
      </SidePanel>
      <Dialog
        actions={
          <>
            <Button onClick={() => setDiscardOpen(false)} theme="outlined" type="button" variant="secondary">
              {t('tagging.tags.form.discardKeep')}
            </Button>
            <Button onClick={onClose} type="button" variant="danger">
              {t('tagging.tags.form.discardConfirm')}
            </Button>
          </>
        }
        closeLabel={dialogCloseLabel}
        customTrigger
        description={t('tagging.tags.form.discardDescription')}
        hideCloseButton
        onOpenChange={(details) => setDiscardOpen(details.open)}
        open={discardOpen}
        role="alertdialog"
        size="sm"
        title={t('tagging.tags.form.discardTitle')}
      />
    </>
  );
};

const refreshCatalog = Effect.sync(refreshTagCatalog);

/**
 * Edit one existing tag. Changes save themselves (debounced, on blur and on Zavřít) only while the owner still has
 * the tag as the draft started from; when someone else changed it, the panel offers the current version instead.
 */
const TagEditPanel = ({ onClose, tag }: { onClose: () => void; tag: TagWithCounts }) => {
  const { t } = useModernI18n();
  const server = tagDraftOf(tag);
  /** The version of the tag the draft builds on: what it opened with, last saved or reloaded. */
  const base = useRef(server);
  const autosave = useAutosaveDraft<TagDraft, never>({
    equals: sameTagDraft,
    isValid: validTagDraft,
    refresh: refreshCatalog,
    runtime: browserRuntime,
    save: (value) =>
      tagAutosaveResult(
        applyTaggingCommandIfUnchanged(updateTagCommand(tag.id, value), tagUnchangedSince(tag.id, base.current)),
      ).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            if (result === 'saved') {
              base.current = value;
            }
          }),
        ),
      ),
    server,
  });
  const settledOnServer = !autosave.pending && sameTagDraft(autosave.draft, server);
  useEffect(() => {
    if (settledOnServer) {
      base.current = server;
    }
  }, [base, server, settledOnServer]);
  const close = () => {
    autosave.flush();
    onClose();
  };
  const handleFlush = autosave.flush;
  const handleDraftChange = autosave.setDraft;
  const handleRetry = autosave.retry;
  const handleReloadLatest = autosave.reloadLatest;
  return (
    <SidePanel
      actions={
        <>
          <AutosaveStatus onReloadLatest={handleReloadLatest} onRetry={handleRetry} status={autosave.status} />
          <Button onClick={close} theme="outlined" variant="secondary">
            {t('tagging.tags.form.close')}
          </Button>
        </>
      }
      onOpenChange={(next) => {
        if (!next) {
          close();
        }
      }}
      open
      resizeLabel={t(resizeKey)}
      size="md"
      title={t('tagging.tags.edit')}
    >
      <form
        className="flex flex-col gap-200 py-200"
        onSubmit={(event) => {
          event.preventDefault();
          autosave.flush();
        }}
      >
        <TagFields draft={autosave.draft} onBlur={handleFlush} onChange={handleDraftChange} showErrors />
      </form>
    </SidePanel>
  );
};

type DeleteError = Effect.Error<ReturnType<typeof applyTaggingCommand>>;
const DeleteFailureSchema = Schema.Literals(['conflict', 'failure', 'forbidden']);
type DeleteFailure = typeof DeleteFailureSchema.Type;

/**
 * What a failed delete means. A tag the owner no longer has, or a delete it already committed, is gone, so the
 * dialog reports it as deleted. A refusal and a concurrent change each get their own message; anything else is a
 * plain failure the user may retry.
 */
const deleteOutcomeOf = (error: DeleteError): DeleteFailure | 'gone' => {
  if (
    Predicate.isTagged(error, 'ApplyCommandActionAlreadyCommittedProblem') ||
    (Predicate.isTagged(error, 'ApplyCommandActionNotFoundProblem') && error.code === 'tagging_not_found')
  ) {
    return 'gone';
  }
  if (Predicate.isTagged(error, 'ApplyCommandActionForbiddenProblem')) {
    return 'forbidden';
  }
  return Predicate.isTagged(error, 'ApplyCommandActionConflictProblem') ? 'conflict' : 'failure';
};

const DeleteTagDialog = ({
  onClose,
  onDeleted,
  onRefresh,
  tag,
}: {
  onClose: () => void;
  onDeleted: () => void;
  /** Re-reads the table after a failed delete, so its counts show what the owner holds now. */
  onRefresh: () => void;
  tag: TagWithCounts;
}) => {
  const { t } = useModernI18n();
  const toaster = useToast();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<DeleteFailure | null>(null);

  const confirm = () => {
    setBusy(true);
    setFailure(null);
    runTagEffect(applyTaggingCommand({ _tag: 'DeleteTag', id: tag.id }), {
      onFailure: (error) => {
        setBusy(false);
        const outcome = deleteOutcomeOf(error);
        if (outcome === 'gone') {
          toaster.create({ title: t('tagging.tags.delete.alreadyDeleted'), type: 'info' });
          onDeleted();
          onClose();
          return;
        }
        setFailure(outcome);
        onRefresh();
      },
      onSuccess: () => {
        setBusy(false);
        toaster.create({ title: t('tagging.tags.deleted'), type: 'success' });
        onDeleted();
        onClose();
      },
    });
  };

  return (
    <Dialog
      actions={
        <>
          <CancelButton onClick={onClose} />
          <Button
            isLoading={busy}
            loadingText={t('tagging.tags.delete.busy')}
            onClick={() => confirm()}
            variant="danger"
          >
            {t('tagging.tags.delete.submit')}
          </Button>
        </>
      }
      closeLabel={dialogCloseLabel}
      customTrigger
      description={t('tagging.tags.delete.description')}
      onOpenChange={(details) => {
        if (!details.open) {
          onClose();
        }
      }}
      open
      role="alertdialog"
      size="sm"
      title={t('tagging.tags.delete.title', { name: tag.name })}
    >
      {failure !== null && (
        <div className="py-200">
          <StatusText showIcon status="error">
            {t(`tagging.tags.delete.${failure}`)}
          </StatusText>
        </div>
      )}
    </Dialog>
  );
};

type KindState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly ids: readonly SubjectId[]; readonly names: SubjectNames; readonly status: 'ready' };

const unknownNameKey = (kind: SubjectKind) =>
  kind === 'customer' ? 'tagging.tags.assigned.unknownCustomer' : 'tagging.tags.assigned.unknown';

/** Rows of one expanded kind: human names, with a muted fallback for ids that have no readable record. */
const KindRows = ({ kind, state }: { kind: SubjectKind; state: KindState }) => {
  const { t } = useModernI18n();
  if (state.status === 'loading') {
    return <p className="text-fg-secondary text-sm">{t('tagging.tags.assigned.loading')}</p>;
  }
  if (state.status === 'error') {
    return (
      <StatusText showIcon status="error">
        {t('tagging.tags.assigned.failed')}
      </StatusText>
    );
  }
  if (state.ids.length === 0) {
    return <p className="text-fg-secondary text-sm">{t('tagging.tags.assigned.empty')}</p>;
  }
  return (
    <ul className="flex flex-col gap-50">
      {state.ids.map((id) => {
        const name = state.names.get(id);
        return (
          <li className="text-sm" key={id}>
            {name ?? <span className="text-fg-secondary">{t(unknownNameKey(kind))}</span>}
          </li>
        );
      })}
    </ul>
  );
};

/** One kind of the drill-down. Its subject ids and names load the first time it expands. */
const KindSection = ({ kind, tagId, total }: { kind: SubjectKind; tagId: TagId; total: number }) => {
  const { t } = useModernI18n();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<KindState>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    if (open) {
      runTagEffect(
        subjectsWithTag(kind, tagId).pipe(
          Effect.flatMap((ids) => loadSubjectNames(kind, ids).pipe(Effect.map((names) => ({ ids, names })))),
        ),
        {
          onFailure: () => {
            if (active) {
              setState({ status: 'error' });
            }
          },
          onSuccess: ({ ids, names }) => {
            if (active) {
              setState({ ids, names, status: 'ready' });
            }
          },
        },
      );
    }
    return () => {
      active = false;
    };
  }, [kind, open, tagId]);

  // The rows load on the first expand; the loading state is set here, not inside the effect.
  const toggle = () => {
    if (!open) {
      setState({ status: 'loading' });
    }
    setOpen(!open);
  };

  return (
    <section className="flex flex-col gap-100">
      <button
        aria-expanded={open}
        className="flex items-center justify-between gap-100 text-left font-semibold text-sm"
        onClick={() => toggle()}
        type="button"
      >
        <span className="flex items-center gap-100">
          <span aria-hidden className={open ? 'icon-[mdi--chevron-down]' : 'icon-[mdi--chevron-right]'} />
          {t(`tagging.kinds.${kind}`)}
        </span>
        <span className="tabular-nums">{total}</span>
      </button>
      {open && <KindRows kind={kind} state={state} />}
    </section>
  );
};

const TagAssignmentsDialog = ({ onClose, tag }: { onClose: () => void; tag: TagWithCounts }) => {
  const { t } = useModernI18n();
  return (
    <SidePanel
      actions={<CancelButton onClick={onClose} />}
      description={t('tagging.tags.assigned.description')}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      open
      resizeLabel={t(resizeKey)}
      size="md"
      title={t('tagging.tags.assigned.title', { name: tag.name })}
    >
      <div className="flex flex-col gap-200 py-200">
        {kindsOf(tag).map((kind) => (
          <KindSection key={kind} kind={kind} tagId={tag.id} total={tag.counts[kind] ?? 0} />
        ))}
      </div>
    </SidePanel>
  );
};

const tagColumns = (t: Translate): ColumnDef<TagWithCounts>[] => [
  {
    accessorKey: 'name',
    cell: (info) => <TagBadge color={tagColorValue[info.row.original.color]} name={info.row.original.name} />,
    header: t('tagging.tags.table.name'),
    meta: { width: 240 },
  },
  {
    accessorFn: (row) => row.description ?? '',
    cell: (info) => {
      const value = info.getValue<string>();
      return value === '' ? '—' : <span className="text-fg-secondary">{value}</span>;
    },
    header: t('tagging.tags.table.description'),
    id: 'description',
    meta: { width: 320 },
  },
  {
    cell: (info) => {
      const { counts, subjectKinds } = info.row.original;
      return (
        <span className="flex flex-wrap gap-50">
          {subjectKinds.flatMap((kind) => {
            const count = counts[kind] ?? 0;
            if (count === 0) {
              return [];
            }
            const kindLabel = t(`tagging.kinds.${kind}`);
            return [
              <Badge key={kind} size="sm" variant="outline">
                {`${kindLabel} ${count}`}
              </Badge>,
            ];
          })}
        </span>
      );
    },
    enableSorting: false,
    header: t('tagging.tags.table.appliesTo'),
    id: 'appliesTo',
    meta: { width: 360 },
  },
];

const TagsPageContent = () => {
  const { t } = useModernI18n();
  // The Shell preloads the shared catalog before it reveals the page, so the rows are here in the first render.
  const catalog = useTagCatalogSnapshot(true);
  const status = tagCatalogStatusOf(catalog);
  const [globalFilter, setGlobalFilter] = useState('');
  const [editor, setEditor] = useState<{ readonly tag: TagWithCounts | null } | null>(null);
  const [removing, setRemoving] = useState<TagWithCounts | null>(null);
  const [inspecting, setInspecting] = useState<TagWithCounts | null>(null);

  // A refresh keeps the rows on screen; only a failed read without rows shows the loading state while it retries.
  const reload = refreshTagCatalog;
  const tags = catalog.state === 'ready' ? catalog.value : noTags;
  // The Popis column only earns its width when at least one tag has a description.
  const hasDescriptions = tags.some((tag) => (tag.description ?? '') !== '');
  const columns = tagColumns(t).filter((column) => hasDescriptions || column.id !== 'description');

  return (
    <>
      <UltramodernRouteHead />
      <PageHeader
        actions={
          <Button icon="icon-[mdi--plus]" onClick={() => setEditor({ tag: null })} size="sm" variant="primary">
            {t(newTagKey)}
          </Button>
        }
        description={t('tagging.pages.records.description')}
        title={t('tagging.pages.records.title')}
      />
      <DataTable
        columns={columns}
        data={tags}
        enableGlobalFilter
        enablePagination
        enableSorting
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.original.name}
        globalFilter={globalFilter}
        loading={status === 'loading'}
        loadingRowCount={6}
        maxHeight="calc(100dvh - 15rem)"
        onGlobalFilterChange={(next) => setGlobalFilter(next)}
        onRowClick={(row) => setInspecting(row.original)}
        pageSizeOptions={[50, 100, 200]}
        paginationProps={{ translations: paginationTranslations }}
        renderEmpty={() => {
          if (status === 'forbidden') {
            return <EmptyState title={t('tagging.pages.records.forbidden')} />;
          }
          if (status === 'error') {
            return (
              <EmptyState
                action={
                  <Button onClick={() => reload()} size="sm" theme="outlined" variant="secondary">
                    {t('tagging.tags.retry')}
                  </Button>
                }
                title={t('tagging.pages.records.unavailable')}
              />
            );
          }
          if (globalFilter !== '') {
            return (
              <EmptyState
                action={
                  <Button onClick={() => setGlobalFilter('')} size="sm" theme="outlined" variant="secondary">
                    {t('tagging.tags.table.clearSearch')}
                  </Button>
                }
                title={t('tagging.tags.table.noResults')}
              />
            );
          }
          return (
            <EmptyState
              action={
                <Button
                  icon="icon-[mdi--plus]"
                  onClick={() => setEditor({ tag: null })}
                  size="sm"
                  theme="outlined"
                  variant="secondary"
                >
                  {t(newTagKey)}
                </Button>
              }
              description={t('tagging.tags.table.emptyDescription')}
              title={t('tagging.tags.table.empty')}
            />
          );
        }}
        rowActions={[
          {
            icon: 'icon-[mdi--pencil-outline]',
            id: 'edit',
            label: t('tagging.tags.edit'),
            onAction: (row) => setEditor({ tag: row.original }),
          },
          {
            icon: 'icon-[mdi--trash-can-outline]',
            id: 'delete',
            label: t('tagging.tags.delete.submit'),
            onAction: (row) => setRemoving(row.original),
            tone: 'danger',
          },
        ]}
        size="sm"
        stickyHeader
        tableLayout="fixed"
        translations={{
          actionsLabel: t('tagging.tags.table.actions'),
          clearSearchLabel: t('tagging.tags.table.clearSearch'),
          loadingLabel: t('tagging.tags.table.loadingLabel'),
          pageSizeLabel: t('tagging.tags.table.pageSize'),
          rangeLabel: ({ end, start, total }) => t('tagging.tags.table.range', { end, start, total }),
          searchButtonLabel: t(searchKey),
          searchLabel: t('tagging.tags.table.searchLabel'),
          searchPlaceholder: t(searchKey),
        }}
      />
      {editor !== null && editor.tag === null && <TagCreateDialog onClose={() => setEditor(null)} />}
      {editor !== null && editor.tag !== null && (
        <TagEditPanel
          onClose={() => setEditor(null)}
          tag={tags.find(({ id }) => id === editor.tag?.id) ?? editor.tag}
        />
      )}
      {removing !== null && (
        <DeleteTagDialog
          onClose={() => setRemoving(null)}
          onDeleted={() => reload()}
          onRefresh={() => reload()}
          tag={removing}
        />
      )}
      {inspecting !== null && <TagAssignmentsDialog onClose={() => setInspecting(null)} tag={inspecting} />}
      <Toaster />
    </>
  );
};

export const RecordsPage = () => {
  const location = useRouterState({ select: (state) => state.location.href });
  return (
    <TagI18n>
      <TagsPageContent key={location} />
    </TagI18n>
  );
};

/** The Shell awaits this before it reveals the page, so the table renders the tags in its first commit. */
export const preloadPage = modulePagePreload(() => preloadTagCatalog);
export default RecordsPage;
