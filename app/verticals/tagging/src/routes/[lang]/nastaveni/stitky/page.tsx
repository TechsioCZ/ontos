import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { Toaster, useToast } from '@techsio/ui-kit/molecules/toast';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import type { ColumnDef } from '@techsio/ui-kit/organisms/data-table';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { Effect, Random } from 'effect';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { executeApplyCommand } from '../../../../api/apply-command-action-client.ts';
import { executeRecords, subjectsWithTag } from '../../../../api/records-client.ts';
import { runTagEffect, TagChip, TagI18n, tagColorValue } from '../../../../components/tag-controls.tsx';
import type { TaggingCommand } from '../../../../../shared/actions/apply-command.ts';
import { subjectKindValues, tagColorValues } from '../../../../../shared/apis/records.ts';
import type { SubjectId, SubjectKind, TagColor, TagWithCounts } from '../../../../../shared/apis/records.ts';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import '../../../index.css';

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly tags: TagWithCounts[] };

interface Draft {
  readonly color: TagColor;
  readonly description: string;
  readonly kinds: readonly SubjectKind[];
  readonly name: string;
}

type Translate = ReturnType<typeof useModernI18n>['t'];

const nameMaxLength = 60;
const noTags: TagWithCounts[] = [];
const newTagKey = 'tagging.tags.new';
const searchKey = 'tagging.tags.table.search';

/** The kinds a tag applies to, in the canonical order. */
const kindsOf = (tag: TagWithCounts) => {
  const applies = new Set(tag.subjectKinds);
  return subjectKindValues.filter((kind) => applies.has(kind));
};

// Every command reads the current revision first and sends it as expectedRevision.
const correlation = (label: string) =>
  Effect.all([Random.nextInt, Random.nextInt], { concurrency: 1 }).pipe(
    Effect.map(([first, second]) => `tagging:${label}:${first}:${second}`),
  );
const readRecords = (requestId: number) =>
  correlation(`records:${requestId}`).pipe(Effect.flatMap((id) => executeRecords({}, id)));
const applyTaggingCommand = (command: TaggingCommand) =>
  readRecords(0).pipe(
    Effect.flatMap((current) =>
      correlation('command').pipe(
        Effect.flatMap((id) =>
          executeApplyCommand({ command, expectedRevision: current.revision }, id, { idempotencyKey: id }),
        ),
      ),
    ),
  );

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

const EmptyBlock = ({ action, description, title }: { action?: ReactNode; description?: ReactNode; title: string }) => (
  <div className="flex flex-col items-center gap-150 p-450 text-center">
    <div className="flex flex-col gap-50">
      <p className="font-semibold text-md">{title}</p>
      {description !== undefined && <div className="max-w-prose text-fg-secondary text-sm">{description}</div>}
    </div>
    {action}
  </div>
);

const TagEditorDialog = ({
  onClose,
  onSaved,
  tag,
}: {
  onClose: () => void;
  onSaved: () => void;
  tag: TagWithCounts | null;
}) => {
  const { t } = useModernI18n();
  const toaster = useToast();
  const [draft, setDraft] = useState<Draft>(() => ({
    color: tag?.color ?? 'blue',
    description: tag?.description ?? '',
    kinds: tag?.subjectKinds ?? [],
    name: tag?.name ?? '',
  }));
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const trimmedName = draft.name.trim();
  const nameInvalid = trimmedName === '' || trimmedName.length > nameMaxLength;
  let nameError = '';
  if (trimmedName === '') {
    nameError = t('tagging.tags.form.nameRequired');
  } else if (trimmedName.length > nameMaxLength) {
    nameError = t('tagging.tags.form.nameTooLong');
  }
  const kindsInvalid = draft.kinds.length === 0;
  const selectedKinds = new Set(draft.kinds);
  const showNameError = submitted && nameInvalid;
  const showKindsError = submitted && kindsInvalid;

  const submit = () => {
    setSubmitted(true);
    if (nameInvalid || kindsInvalid) {
      return;
    }
    const description = draft.description.trim();
    const command: TaggingCommand =
      tag === null
        ? { _tag: 'CreateTag', color: draft.color, description, name: trimmedName, subjectKinds: [...draft.kinds] }
        : {
            _tag: 'UpdateTag',
            id: tag.id,
            // An empty description clears the stored one.
            patch: { color: draft.color, description, name: trimmedName, subjectKinds: [...draft.kinds] },
          };
    setBusy(true);
    setFailed(false);
    runTagEffect(applyTaggingCommand(command), {
      onFailure: () => {
        setBusy(false);
        setFailed(true);
      },
      onSuccess: () => {
        setBusy(false);
        toaster.create({ title: t(tag === null ? 'tagging.tags.created' : 'tagging.tags.updated'), type: 'success' });
        onSaved();
        onClose();
      },
    });
  };

  const colorItems = tagColorValues.map((color) => ({
    label: (
      <span className="flex items-center gap-100">
        <span
          aria-hidden
          className="size-100 shrink-0 rounded-full"
          style={{ backgroundColor: tagColorValue[color] }}
        />
        {t(`tagging.colors.${color}`)}
      </span>
    ),
    value: color,
  }));

  return (
    <Dialog
      actions={
        <>
          <CancelButton onClick={onClose} />
          <Button
            isLoading={busy}
            loadingText={t('tagging.tags.form.saving')}
            onClick={() => submit()}
            variant="primary"
          >
            {t(tag === null ? 'tagging.tags.form.createSubmit' : 'tagging.tags.form.editSubmit')}
          </Button>
        </>
      }
      onOpenChange={(details) => {
        if (!details.open) {
          onClose();
        }
      }}
      open
      placement="right"
      size="md"
      title={t(tag === null ? newTagKey : 'tagging.tags.edit')}
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
        <FormInput
          helpText={showNameError ? nameError : undefined}
          id="tag-name"
          label={t('tagging.tags.form.name')}
          name="name"
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
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
              setDraft((current) => ({ ...current, color: picked }));
            }
          }}
          value={[draft.color]}
        />
        <FormTextarea
          id="tag-description"
          label={t('tagging.tags.form.description')}
          name="description"
          onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
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
                setDraft((current) => ({ ...current, kinds: toggleKind(current.kinds, kind, checked) }))
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
      </form>
    </Dialog>
  );
};

const DeleteTagDialog = ({
  onClose,
  onDeleted,
  tag,
}: {
  onClose: () => void;
  onDeleted: () => void;
  tag: TagWithCounts;
}) => {
  const { t } = useModernI18n();
  const toaster = useToast();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const confirm = () => {
    setBusy(true);
    setFailed(false);
    runTagEffect(applyTaggingCommand({ _tag: 'DeleteTag', id: tag.id }), {
      onFailure: () => {
        setBusy(false);
        setFailed(true);
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
      {failed && (
        <div className="py-200">
          <StatusText showIcon status="error">
            {t('tagging.tags.failure')}
          </StatusText>
        </div>
      )}
    </Dialog>
  );
};

type AssignmentsState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly byKind: ReadonlyMap<SubjectKind, readonly SubjectId[]>; readonly status: 'ready' };

const TagAssignmentsDialog = ({ onClose, tag }: { onClose: () => void; tag: TagWithCounts }) => {
  const { t } = useModernI18n();
  const [state, setState] = useState<AssignmentsState>({ status: 'loading' });
  const kinds = kindsOf(tag);

  useEffect(() => {
    let active = true;
    const loadKinds = kindsOf(tag);
    runTagEffect(
      Effect.forEach(loadKinds, (kind) => subjectsWithTag(kind, tag.id), { concurrency: 1 }),
      {
        onFailure: () => {
          if (active) {
            setState({ status: 'error' });
          }
        },
        onSuccess: (lists) => {
          if (active) {
            setState({
              byKind: new Map(
                loadKinds.map((kind, index): [SubjectKind, readonly SubjectId[]] => [kind, lists[index] ?? []]),
              ),
              status: 'ready',
            });
          }
        },
      },
    );
    return () => {
      active = false;
    };
  }, [tag]);

  return (
    <Dialog
      actions={<CancelButton onClick={onClose} />}
      description={t('tagging.tags.assigned.description')}
      onOpenChange={(details) => {
        if (!details.open) {
          onClose();
        }
      }}
      open
      placement="right"
      size="md"
      title={t('tagging.tags.assigned.title', { name: tag.name })}
    >
      <div className="flex flex-col gap-250 py-200">
        {state.status === 'loading' && (
          <p className="text-fg-secondary text-sm">{t('tagging.tags.assigned.loading')}</p>
        )}
        {state.status === 'error' && (
          <StatusText showIcon status="error">
            {t('tagging.tags.assigned.failed')}
          </StatusText>
        )}
        {state.status === 'ready' &&
          kinds.map((kind) => {
            const ids = state.byKind.get(kind) ?? [];
            return (
              <section className="flex flex-col gap-100" key={kind}>
                <h2 className="flex items-center gap-100 font-semibold text-sm">
                  {t(`tagging.kinds.${kind}`)}
                  <span className="tabular-nums">{ids.length}</span>
                </h2>
                {ids.length === 0 ? (
                  <p className="text-fg-secondary text-sm">{t('tagging.tags.assigned.empty')}</p>
                ) : (
                  <ul className="flex flex-col gap-50">
                    {ids.map((id) => (
                      <li className="break-all text-fg-secondary text-xs" key={id}>
                        {id}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
      </div>
    </Dialog>
  );
};

const tagColumns = (t: Translate): ColumnDef<TagWithCounts>[] => [
  {
    accessorKey: 'name',
    cell: (info) => <TagChip color={tagColorValue[info.row.original.color]} name={info.row.original.name} />,
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
    cell: (info) => (
      <span className="flex flex-wrap gap-50">
        {info.row.original.subjectKinds.map((kind) => {
          const kindLabel = t(`tagging.kinds.${kind}`);
          return (
            <Badge key={kind} size="sm" variant="outline">
              {`${kindLabel} ${info.row.original.counts[kind] ?? 0}`}
            </Badge>
          );
        })}
      </span>
    ),
    enableSorting: false,
    header: t('tagging.tags.table.appliesTo'),
    id: 'appliesTo',
    meta: { width: 360 },
  },
];

const TagsPageContent = () => {
  const { t } = useModernI18n();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [request, setRequest] = useState({ id: 0 });
  const [globalFilter, setGlobalFilter] = useState('');
  const [editor, setEditor] = useState<{ readonly tag: TagWithCounts | null } | null>(null);
  const [removing, setRemoving] = useState<TagWithCounts | null>(null);
  const [inspecting, setInspecting] = useState<TagWithCounts | null>(null);

  useEffect(() => {
    let active = true;
    runTagEffect(readRecords(request.id), {
      onFailure: () => {
        if (active) {
          setState({ status: 'error' });
        }
      },
      onSuccess: (records) => {
        if (active) {
          setState({ status: 'ready', tags: [...records.tags] });
        }
      },
    });
    return () => {
      active = false;
    };
  }, [request]);

  // Refreshes keep the rows on screen; only a first load without rows shows the loading state.
  const reload = () => {
    setState((current) => (current.status === 'ready' ? current : { status: 'loading' }));
    setRequest((current) => ({ id: current.id + 1 }));
  };
  const tags = state.status === 'ready' ? state.tags : noTags;

  return (
    <>
      <UltramodernRouteHead />
      <header className="flex flex-col gap-150">
        <div className="flex flex-wrap items-start justify-between gap-200">
          <div className="flex min-w-0 flex-col gap-100">
            <h1 className="font-semibold text-xl">{t('tagging.pages.records.title')}</h1>
            <p className="max-w-prose text-fg-secondary text-sm">{t('tagging.pages.records.description')}</p>
          </div>
          <div className="flex flex-wrap items-center gap-100">
            <Button icon="icon-[mdi--plus]" onClick={() => setEditor({ tag: null })} size="sm" variant="primary">
              {t(newTagKey)}
            </Button>
          </div>
        </div>
      </header>
      <DataTable
        columns={tagColumns(t)}
        data={tags}
        enableGlobalFilter
        enablePagination
        enableSorting
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.original.name}
        globalFilter={globalFilter}
        loading={state.status === 'loading'}
        loadingRowCount={6}
        maxHeight="calc(100dvh - 15rem)"
        onGlobalFilterChange={(next) => setGlobalFilter(next)}
        onRowClick={(row) => setInspecting(row.original)}
        pageSizeOptions={[50, 100, 200]}
        renderEmpty={() => {
          if (state.status === 'error') {
            return (
              <EmptyBlock
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
              <EmptyBlock
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
            <EmptyBlock
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
          pageSizeLabel: t('tagging.tags.table.pageSize'),
          rangeLabel: ({ end, start, total }) => t('tagging.tags.table.range', { end, start, total }),
          searchButtonLabel: t(searchKey),
          searchLabel: t(searchKey),
          searchPlaceholder: t(searchKey),
        }}
      />
      {editor !== null && <TagEditorDialog onClose={() => setEditor(null)} onSaved={() => reload()} tag={editor.tag} />}
      {removing !== null && (
        <DeleteTagDialog onClose={() => setRemoving(null)} onDeleted={() => reload()} tag={removing} />
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

export default RecordsPage;
