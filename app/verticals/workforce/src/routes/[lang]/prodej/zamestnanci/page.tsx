import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import {
  BulkActionBar,
  EmptyState,
  PageHeader,
  StatCard,
  StatRow,
  formatNumber,
  Toaster,
  dataTableRowLabels,
  paginationTranslations,
} from '@app/admin-ui';
import { BulkTagDialog, TagCell, TagFilter, useTagsOfKind } from '@app/tagging/components/tag-controls';
import type { TagCatalog, TagsStatus } from '@app/tagging/components/tag-controls';
import type { SubjectId, Tag, TagId } from '@app/tagging/contracts/records';
import { SubjectIdSchema } from '@app/tagging/contracts/records';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Input } from '@techsio/ui-kit/atoms/input';
import { Skeleton } from '@techsio/ui-kit/atoms/skeleton';
import { Accordion } from '@techsio/ui-kit/molecules/accordion';
import { Switch } from '@techsio/ui-kit/molecules/switch';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import type { CellContext, ColumnDef, DataTableTranslations, Row } from '@techsio/ui-kit/organisms/data-table';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { Effect, Match, Option, Schema } from 'effect';
import { createContext, use, useEffect, useState } from 'react';
import { executeApplyCommand } from '../../../../api/apply-command-action-client.ts';
import { executeRecords } from '../../../../api/records-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import type { Employee, EmployeeRole, RecordsResponse } from '../../../../../shared/apis/records.ts';
import csResource from '../../../../../locales/cs/workforce.json';
import enResource from '../../../../../locales/en/workforce.json';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import '../../../index.css';
import { BulkDepartmentDialog, BulkRoleDialog, EmployeeFormDialog, selectLabelProps } from './employee-dialogs.tsx';
import type { CommitCommand, ShownEdit } from './employee-dialogs.tsx';
import type { CommitOutcome, EmployeeFilters } from './employee-model.ts';
import {
  allOption,
  bulkCommand,
  departmentFromValue,
  departmentsOf,
  employeeRoles,
  filterEmployees,
  hasActiveFilters,
  newRequestToken,
  noFilters,
  roleFromValue,
  sortEmployees,
} from './employee-model.ts';

const workforceI18nResources = {
  cs: { workforce: csResource },
  en: { workforce: enResource },
} as const;

const key = 'workforce.pages.employees';
const pageSizeOptions = [50, 100, 200];
/** The row-selection column stays first, ahead of the pinned name. */
const pinning = { end: [], start: ['__select', 'fullName'] };

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'forbidden' }
  | { readonly data: RecordsResponse; readonly status: 'ready' };

/** Row selection as the ui-kit DataTable types it: selected row ids only. */
type Selection = Record<string, true>;

const BulkDialogKindSchema = Schema.Literals(['department', 'role']);
type BulkDialogKind = typeof BulkDialogKindSchema.Type;

/** Sales staff are the heads and the representatives; the stat row counts both. */
const salesStaff = (byRole: Partial<Record<EmployeeRole, number>>): number =>
  (byRole.SALES_HEAD ?? 0) + (byRole.SALES_REP ?? 0);

/** Reads every Employee the caller may see, unfiltered, so the stat tiles describe the whole team. */
const loadEmployees = (onLoaded: (state: LoadState) => void): void => {
  void browserRuntime.runPromise(
    newRequestToken.pipe(
      Effect.flatMap((token) => executeRecords({}, `workforce:list:${token}`)),
      Effect.match({
        onFailure: (error): LoadState =>
          Match.value(error).pipe(
            Match.tag('RecordsForbiddenProblem', (): LoadState => ({ status: 'forbidden' })),
            Match.orElse((): LoadState => ({ status: 'error' })),
          ),
        onSuccess: (data): LoadState => ({ data, status: 'ready' }),
      }),
      Effect.map(onLoaded),
    ),
  );
};

/** Text columns sort in Czech collation. The default sort compares code points, so "Účetní" would land after "Vedoucí". */
const czechSortFn = (left: Row<Employee>, right: Row<Employee>, columnId: string): number =>
  left.getValue<string>(columnId).localeCompare(right.getValue<string>(columnId), 'cs');

const nameCell = (info: CellContext<Employee>) => (
  <span className="block truncate font-medium">{info.row.original.fullName}</span>
);
const emailCell = (info: CellContext<Employee>) => <span className="block truncate">{info.row.original.email}</span>;
const statusCell = (info: CellContext<Employee>) => (
  <Badge size="sm" variant={info.row.original.active ? 'success' : 'outline'}>
    {info.getValue<string>()}
  </Badge>
);
/** A linked account is a small text marker; the role already has its own column. */
const accountCell = (info: CellContext<Employee>) =>
  info.row.original.principalRef === undefined ? (
    <span className="block text-fg-secondary">—</span>
  ) : (
    <span className="block text-xs text-fg-secondary">{info.getValue<string>()}</span>
  );

/** Tagging subject ids are the employee ids. An id that does not decode as a subject id is skipped, never thrown. */
const subjectIdOf = (id: string): Option.Option<SubjectId> => Schema.decodeOption(SubjectIdSchema)(id);
const subjectIdsOf = (ids: readonly string[]): SubjectId[] =>
  ids.flatMap((id) =>
    Option.match(subjectIdOf(id), {
      onNone: (): SubjectId[] => [],
      onSome: (subject): SubjectId[] => [subject],
    }),
  );

type TagsBySubject = ReadonlyMap<SubjectId, readonly Tag[]>;

/** Tags of the listed employees and their load status, shared with the Štítky cells. */
const EmployeeTagsContext = createContext<TagsBySubject>(new Map());
const EmployeeTagStatusContext = createContext<TagsStatus>('loading');

const tagsOf = (tagsBySubject: TagsBySubject, id: string): readonly Tag[] =>
  Option.match(subjectIdOf(id), {
    onNone: (): readonly Tag[] => [],
    onSome: (subject): readonly Tag[] => tagsBySubject.get(subject) ?? [],
  });

/**
 * The Štítky cell reads the tags from context, not from a column accessor. The table caches accessor values per row
 * until its rows rebuild, so a cached "still loading" value would outlive the tags read and a bulk tag change.
 */
const EmployeeTagsCell = ({ row }: CellContext<Employee>) => {
  const status = use(EmployeeTagStatusContext);
  const tagsBySubject = use(EmployeeTagsContext);
  return <TagCell loading={status === 'loading'} tags={tagsOf(tagsBySubject, row.original.id)} />;
};

/** Maps a failed apply-command call to the outcome the forms show. A duplicate e-mail stays on the field. */
const outcomeOfFailure = (error: Effect.Error<ReturnType<typeof executeApplyCommand>>): CommitOutcome =>
  Match.value(error).pipe(
    Match.tag('ApplyCommandActionConflictProblem', (problem): CommitOutcome =>
      problem.code === 'workforce_revision_conflict' ? 'conflict' : 'failed',
    ),
    Match.tag('ApplyCommandActionIneligibleProblem', (problem): CommitOutcome =>
      problem.code === 'workforce_duplicate_email' ? 'duplicateEmail' : 'failed',
    ),
    Match.tag('ApplyCommandActionForbiddenProblem', (): CommitOutcome => 'forbidden'),
    Match.orElse((): CommitOutcome => 'failed'),
  );

/** The list after a saved edit: the named rows show the saved fields. The reread that follows brings the server's values. */
const withSavedEdit = (state: LoadState, shown: ShownEdit): LoadState => {
  if (state.status !== 'ready') {
    return state;
  }
  const ids = new Set(shown.ids);
  return {
    ...state,
    data: {
      ...state.data,
      items: state.data.items.map((employee) => (ids.has(employee.id) ? { ...employee, ...shown.patch } : employee)),
    },
  };
};

/** Rows that carry the selected tag, read from the tags the list already loaded. No tag selected keeps every row. */
const rowsWithTag = (rows: readonly Employee[], tagId: TagId | null, tagsBySubject: TagsBySubject): Employee[] =>
  tagId === null ? [...rows] : rows.filter((row) => tagsOf(tagsBySubject, row.id).some((tag) => tag.id === tagId));

/** Static role matrix from app/scripts/demo/permissions.mts. Read-only, for the demo audience. */
const accessRows = [
  { access: 'vše', role: 'Vedoucí obchodu' },
  { access: 'zákazníci, příležitosti, úkoly, štítky; faktury jen čtení', role: 'Obchodník' },
  { access: 'faktury, zákazníci (čtení), statistiky', role: 'Účetní' },
  { access: 'produkty a sklad, úkoly', role: 'Skladník' },
  {
    access: 'čtení všeho; zápis jen úkoly, příležitosti, štítky; bez cen, faktur a mazání štítků',
    role: 'Agent (bot)',
  },
] as const;

/** Read-only overview of who may do what in the demo. Static copy; the matrix lives in the demo permissions script. Collapsed by default. */
const PermissionsCard = () => {
  const { t } = useModernI18n();
  return (
    <Accordion className="rounded-lg border border-border-primary bg-surface" collapsible multiple={false}>
      <Accordion.Item value="permissions">
        <Accordion.Header aria-level={2}>
          <Accordion.Title>{t(`${key}.permissions.title`)}</Accordion.Title>
          <Accordion.Indicator />
        </Accordion.Header>
        <Accordion.Content>
          <div className="overflow-x-auto p-250 pt-150">
            <table className="w-full table-fixed border-collapse text-left text-sm">
              <thead>
                <tr className="border-border-primary border-b">
                  <th className="w-56 py-100 pr-150 font-medium">{t(`${key}.permissions.role`)}</th>
                  <th className="py-100 font-medium">{t(`${key}.permissions.access`)}</th>
                </tr>
              </thead>
              <tbody>
                {accessRows.map((row) => (
                  <tr className="border-border-primary border-b last:border-b-0" key={row.role}>
                    <td className="py-100 pr-150 align-top font-medium">{row.role}</td>
                    <td className="py-100 align-top">{row.access}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Accordion.Content>
      </Accordion.Item>
    </Accordion>
  );
};

const format = (count: number | undefined) => (count === undefined ? '—' : formatNumber(count));

const EmployeeStats = ({
  data,
  loading,
}: {
  readonly data: RecordsResponse | undefined;
  readonly loading: boolean;
}) => {
  const { t } = useModernI18n();
  if (loading) {
    return (
      <StatRow>
        {[0, 1, 2, 3].map((index) => (
          <Skeleton isLoaded={false} key={index}>
            <Skeleton.Rectangle className="h-22 w-full" />
          </Skeleton>
        ))}
      </StatRow>
    );
  }
  const indicators = data?.indicators;
  return (
    <StatRow>
      <StatCard label={t(`${key}.stats.total`)} value={format(indicators?.total)} />
      <StatCard label={t(`${key}.stats.active`)} value={format(indicators?.active)} />
      <StatCard
        label={t(`${key}.stats.sales`)}
        value={format(indicators === undefined ? undefined : salesStaff(indicators.byRole))}
      />
      <StatCard label={t(`${key}.stats.departments`)} value={format(indicators?.byDepartment.length)} />
    </StatRow>
  );
};

const EmployeeFilterBar = ({
  departments,
  filters,
  onChange,
  onTagChange,
  tagCatalog,
  tagValue,
}: {
  readonly departments: readonly string[];
  readonly filters: EmployeeFilters;
  readonly onChange: (patch: Partial<EmployeeFilters>) => void;
  readonly onTagChange: (tagId: TagId | null) => void;
  readonly tagCatalog: TagCatalog;
  readonly tagValue: TagId | null;
}) => {
  const { t } = useModernI18n();
  const roleItems = [
    { displayValue: t(`${key}.filters.allRoles`), label: t(`${key}.filters.allRoles`), value: allOption },
    ...employeeRoles.map((role) => {
      const label = t(`${key}.roles.${role}`);
      return { displayValue: label, label, value: role };
    }),
  ];
  const departmentItems = [
    { displayValue: t(`${key}.filters.allDepartments`), label: t(`${key}.filters.allDepartments`), value: allOption },
    ...departments.map((department) => ({ displayValue: department, label: department, value: department })),
  ];
  return (
    <div className="flex flex-wrap items-end gap-150">
      <Input
        aria-label={t(`${key}.filters.searchLabel`)}
        className="w-64"
        onChange={(event) => onChange({ query: event.target.value })}
        placeholder={t(`${key}.filters.search`)}
        size="sm"
        type="search"
        value={filters.query}
      />
      <SelectTemplate
        className="w-48"
        items={roleItems}
        label={t(`${key}.filters.role`)}
        labelProps={selectLabelProps}
        name="roleFilter"
        onValueChange={(details) => onChange({ role: roleFromValue(details.value[0]) })}
        placeholder={t('workforce.selectPlaceholder')}
        size="sm"
        value={[filters.role ?? allOption]}
      />
      <SelectTemplate
        className="w-48"
        items={departmentItems}
        label={t(`${key}.filters.department`)}
        labelProps={selectLabelProps}
        name="departmentFilter"
        onValueChange={(details) => onChange({ department: departmentFromValue(details.value[0]) })}
        placeholder={t('workforce.selectPlaceholder')}
        size="sm"
        value={[filters.department ?? allOption]}
      />
      <div className="w-48">
        <TagFilter
          catalog={tagCatalog}
          kind="employee"
          label={t(`${key}.filters.tag`)}
          onChange={onTagChange}
          value={tagValue}
        />
      </div>
      <Switch checked={filters.activeOnly} onCheckedChange={(checked) => onChange({ activeOnly: checked })}>
        {t(`${key}.filters.activeOnly`)}
      </Switch>
    </div>
  );
};

const EmployeeBulkBar = ({
  busy,
  count,
  onClear,
  onDepartment,
  onRole,
  onSetActive,
  onTags,
}: {
  readonly busy: boolean;
  readonly count: number;
  readonly onClear: () => void;
  readonly onDepartment: () => void;
  readonly onRole: () => void;
  readonly onSetActive: (active: boolean) => void;
  readonly onTags: () => void;
}) => {
  const { t } = useModernI18n();
  // No selection renders nothing, so the page column keeps no empty gap for the bar.
  if (count === 0) {
    return null;
  }
  return (
    // Stays under the shell top bar (`--spacing-700` high) while the page scrolls, so the bulk actions stay in reach.
    // The page background hides the rows scrolling under the bar's rounded corners.
    <div className="sticky top-(--spacing-700) z-10 bg-base">
      <BulkActionBar onClear={onClear} selectedCount={count}>
        <Button disabled={busy} onClick={onDepartment} size="sm" theme="outlined" variant="secondary">
          {t(`${key}.bulk.department`)}
        </Button>
        <Button disabled={busy} onClick={onRole} size="sm" theme="outlined" variant="secondary">
          {t(`${key}.bulk.role`)}
        </Button>
        <Button disabled={busy} onClick={onTags} size="sm" theme="outlined" variant="secondary">
          {t(`${key}.bulk.tags`)}
        </Button>
        <Button
          disabled={busy}
          onClick={() => {
            onSetActive(true);
          }}
          size="sm"
          theme="outlined"
          variant="secondary"
        >
          {t(`${key}.bulk.activate`)}
        </Button>
        <Button
          disabled={busy}
          onClick={() => {
            onSetActive(false);
          }}
          size="sm"
          theme="outlined"
          variant="secondary"
        >
          {t(`${key}.bulk.deactivate`)}
        </Button>
      </BulkActionBar>
    </div>
  );
};

/**
 * Table columns. The text columns sort in Czech collation; the others keep the table's default sort. The widths plus the
 * 44 px selection column add up to 1104 px, so at a 1440 px window (256 px sidebar, page padding) the table needs no
 * horizontal scroll and the last column is not clipped. Wider windows share the spare width across the columns.
 */
const employeeColumns = (t: (key: string) => string): ColumnDef<Employee>[] => [
  {
    accessorKey: 'fullName',
    cell: nameCell,
    header: t(`${key}.columns.name`),
    meta: { width: 190 },
    sortFn: czechSortFn,
  },
  {
    cell: EmployeeTagsCell,
    enableSorting: false,
    header: t(`${key}.columns.tags`),
    id: 'tags',
    meta: { width: 160 },
  },
  { accessorKey: 'email', cell: emailCell, header: t(`${key}.columns.email`), meta: { width: 220 } },
  {
    accessorFn: (row) => t(`${key}.roles.${row.role}`),
    header: t(`${key}.columns.role`),
    id: 'role',
    meta: { width: 140 },
    sortFn: czechSortFn,
  },
  {
    accessorKey: 'department',
    header: t(`${key}.columns.department`),
    meta: { width: 150 },
    sortFn: czechSortFn,
  },
  {
    accessorFn: (row) => t(row.active ? `${key}.status.active` : `${key}.status.inactive`),
    cell: statusCell,
    header: t(`${key}.columns.status`),
    id: 'status',
    meta: { width: 100 },
  },
  {
    accessorFn: (row) => t(row.principalRef === undefined ? `${key}.account.none` : `${key}.account.linked`),
    cell: accountCell,
    header: t(`${key}.columns.account`),
    id: 'account',
    meta: { width: 100 },
  },
];

const EmployeesPageContent = () => {
  const { t } = useModernI18n();
  const toaster = useToast();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [filters, setFilters] = useState<EmployeeFilters>(noFilters);
  const [selection, setSelection] = useState<Selection>({});
  const [form, setForm] = useState<{ readonly employee: Employee | null } | null>(null);
  const [bulk, setBulk] = useState<BulkDialogKind | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [tagFilter, setTagFilter] = useState<TagId | null>(null);
  const [tagDialogOpen, setTagDialogOpen] = useState(false);

  useEffect(() => {
    loadEmployees(setState);
  }, []);

  const reload = () => loadEmployees(setState);

  const showSaved = (shown: ShownEdit) => setState((current) => withSavedEdit(current, shown));

  /** Sends one command on the revision the page last read. A conflict or a success reloads the list. */
  const commit: CommitCommand = (build, successKey, shown) => {
    if (state.status !== 'ready') {
      return Effect.succeed<CommitOutcome>('failed');
    }
    const { revision } = state.data;
    return build.pipe(
      Effect.flatMap((command) =>
        newRequestToken.pipe(
          Effect.flatMap((token) =>
            executeApplyCommand({ command, expectedRevision: revision }, `workforce:command:${token}`, {
              idempotencyKey: `workforce:${token}`,
            }),
          ),
        ),
      ),
      Effect.match({
        onFailure: outcomeOfFailure,
        onSuccess: (): CommitOutcome => 'saved',
      }),
      Effect.tap((outcome) =>
        Effect.sync(() => {
          if (outcome === 'saved') {
            if (shown !== undefined) {
              showSaved(shown);
            }
            toaster.create({ title: t(successKey), type: 'success' });
          }
          if (outcome === 'saved' || outcome === 'conflict') {
            reload();
          }
        }),
      ),
    );
  };

  const data = state.status === 'ready' ? state.data : undefined;
  const items = data?.items ?? [];
  const canWrite = data?.canWrite === true;
  // Starts with the employee read instead of after it, so the Štítky cells settle together with the rows. The same
  // read feeds the tag filter, so the page issues no separate catalog read.
  const { catalog: tagCatalog, refetch: refetchTags, status: tagStatus, tagsBySubject } = useTagsOfKind('employee');
  // The tag filter works on the tags already loaded for the list, so picking a tag never waits for another read.
  const tagFilterLoading = tagFilter !== null && tagStatus === 'loading';
  const tagFilterFailed = tagFilter !== null && tagStatus === 'error';
  const visible = rowsWithTag(filterEmployees(sortEmployees(items), filters), tagFilter, tagsBySubject);
  const selectedIds = items.flatMap((employee) => (selection[employee.id] === true ? [employee.id] : []));

  /** Any filter change clears the selection so a bulk action never reaches rows the user cannot see. */
  const updateFilters = (patch: Partial<EmployeeFilters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setSelection({});
  };

  const changeTagFilter = (tagId: TagId | null) => {
    setTagFilter(tagId);
    setSelection({});
  };

  const clearFilters = () => {
    updateFilters(noFilters);
    setTagFilter(null);
  };

  const bulkSetActive = (active: boolean) => {
    setBulkBusy(true);
    void browserRuntime.runPromise(
      commit(Effect.succeed(bulkCommand(selectedIds, { active })), `${key}.toast.bulkSaved`, {
        ids: selectedIds,
        patch: { active },
      }).pipe(
        Effect.tap((outcome) =>
          Effect.sync(() => {
            setBulkBusy(false);
            if (outcome === 'saved') {
              setSelection({});
            } else {
              toaster.create({ title: t(`${key}.toast.error`), type: 'error' });
            }
          }),
        ),
      ),
    );
  };

  const afterBulkSave = () => {
    setBulk(null);
    setSelection({});
  };

  const columns = employeeColumns(t);

  const translations: DataTableTranslations = {
    ...dataTableRowLabels,
    actionsLabel: t(`${key}.table.actions`),
    filtersLabel: t(`${key}.table.filters`),
    loadingLabel: t(`${key}.table.loading`),
    pageSizeLabel: t(`${key}.table.pageSize`),
    rangeLabel: ({ end, start, total }) => t(`${key}.table.range`, { end, start, total }),
    selectAllLabel: t(`${key}.table.selectAll`),
    selectionLabel: t(`${key}.table.selectRow`),
  };

  const openCreate = () => setForm({ employee: null });

  const renderEmpty = () => {
    if (state.status === 'error') {
      return (
        <EmptyState
          action={
            <Button onClick={reload} size="sm" theme="outlined" variant="secondary">
              {t(`${key}.errors.retry`)}
            </Button>
          }
          description={t(`${key}.errors.loadDescription`)}
          title={t(`${key}.errors.load`)}
        />
      );
    }
    if (state.status === 'forbidden') {
      return <EmptyState title={t(`${key}.empty.forbidden`)} />;
    }
    if (tagFilterFailed) {
      return <EmptyState description={t(`${key}.errors.loadDescription`)} title={t(`${key}.errors.load`)} />;
    }
    if (hasActiveFilters(filters) || tagFilter !== null) {
      return (
        <EmptyState
          action={
            <Button onClick={clearFilters} size="sm" theme="outlined" variant="secondary">
              {t(`${key}.filters.clear`)}
            </Button>
          }
          title={t(`${key}.empty.noResults`)}
        />
      );
    }
    return (
      <EmptyState
        action={
          canWrite ? (
            <Button onClick={openCreate} size="sm" theme="outlined" variant="secondary">
              {t(`${key}.create`)}
            </Button>
          ) : undefined
        }
        description={t(`${key}.empty.firstDescription`)}
        title={t(`${key}.empty.first`)}
      />
    );
  };

  return (
    <>
      <UltramodernRouteHead />
      <Toaster />
      <div className="flex min-w-0 flex-col gap-250">
        <PageHeader
          actions={
            canWrite ? (
              <Button icon="icon-[mdi--plus]" onClick={openCreate} size="sm" variant="primary">
                {t(`${key}.create`)}
              </Button>
            ) : undefined
          }
          description={t(`${key}.description`)}
          title={t(`${key}.title`)}
        />

        <EmployeeStats data={data} loading={state.status === 'loading'} />

        <EmployeeFilterBar
          departments={departmentsOf(items)}
          filters={filters}
          onChange={updateFilters}
          onTagChange={changeTagFilter}
          tagCatalog={tagCatalog}
          tagValue={tagFilter}
        />

        {canWrite && (
          <EmployeeBulkBar
            busy={bulkBusy}
            count={selectedIds.length}
            onClear={() => setSelection({})}
            onDepartment={() => setBulk('department')}
            onRole={() => setBulk('role')}
            onSetActive={bulkSetActive}
            onTags={() => setTagDialogOpen(true)}
          />
        )}

        <EmployeeTagStatusContext value={tagStatus}>
          <EmployeeTagsContext value={tagsBySubject}>
            <DataTable
              columnPinning={pinning}
              columns={columns}
              data={visible}
              enableColumnPinning
              enablePagination
              enableRowSelection={canWrite}
              enableSorting
              getRowId={(row) => row.id}
              getRowLabel={(row) => row.original.fullName}
              loading={state.status === 'loading' || tagFilterLoading}
              loadingRowCount={10}
              maxHeight="calc(100dvh - 15rem)"
              paginationProps={{ translations: paginationTranslations }}
              {...(canWrite
                ? { onRowClick: (row: { readonly original: Employee }) => setForm({ employee: row.original }) }
                : {})}
              onRowSelectionChange={setSelection}
              pageSizeOptions={pageSizeOptions}
              renderEmpty={renderEmpty}
              rowSelection={selection}
              size="sm"
              stickyHeader
              tableLayout="fixed"
              translations={translations}
            />
          </EmployeeTagsContext>
        </EmployeeTagStatusContext>

        <PermissionsCard />
      </div>

      {form !== null && <EmployeeFormDialog commit={commit} employee={form.employee} onClose={() => setForm(null)} />}
      <BulkTagDialog
        kind="employee"
        onDone={() => {
          refetchTags();
          // Like the bulk role and department changes, a finished bulk tag change clears the selection.
          setSelection({});
        }}
        onOpenChange={setTagDialogOpen}
        open={tagDialogOpen}
        subjectIds={subjectIdsOf(selectedIds)}
      />
      {bulk === 'department' && (
        <BulkDepartmentDialog commit={commit} ids={selectedIds} onClose={() => setBulk(null)} onSaved={afterBulkSave} />
      )}
      {bulk === 'role' && (
        <BulkRoleDialog commit={commit} ids={selectedIds} onClose={() => setBulk(null)} onSaved={afterBulkSave} />
      )}
    </>
  );
};

const EmployeesPage = () => {
  const location = useRouterState({ select: (routerState) => routerState.location.href });
  return (
    <FederatedI18nBoundary
      defaultNamespace="workforce"
      fallbackLanguage="en"
      resources={workforceI18nResources}
      supportedLanguages={['en', 'cs']}
    >
      <EmployeesPageContent key={location} />
    </FederatedI18nBoundary>
  );
};

/** `vertical.manifest.ts` imports this page under its registered name. */
export { EmployeesPage as RecordsPage };

export default EmployeesPage;
