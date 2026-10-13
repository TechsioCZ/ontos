import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { BulkActionBar, EmptyState, PageHeader, StatCard, StatRow, formatNumber } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Input } from '@techsio/ui-kit/atoms/input';
import { Skeleton } from '@techsio/ui-kit/atoms/skeleton';
import { Switch } from '@techsio/ui-kit/molecules/switch';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import type { CellContext, ColumnDef, DataTableTranslations } from '@techsio/ui-kit/organisms/data-table';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { Effect, Match, Schema } from 'effect';
import { useEffect, useState } from 'react';
import { executeApplyCommand } from '../../../../api/apply-command-action-client.ts';
import { executeRecords } from '../../../../api/records-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import type { Employee, EmployeeRole, RecordsResponse } from '../../../../../shared/apis/records.ts';
import csResource from '../../../../../locales/cs/workforce.json';
import enResource from '../../../../../locales/en/workforce.json';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import '../../../index.css';
import { BulkDepartmentDialog, BulkRoleDialog, EmployeeFormDialog } from './employee-dialogs.tsx';
import type { CommitCommand } from './employee-dialogs.tsx';
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
const pinning = { end: [], start: ['fullName'] };

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

const nameCell = (info: CellContext<Employee>) => (
  <span className="block truncate font-medium">{info.row.original.fullName}</span>
);
const emailCell = (info: CellContext<Employee>) => <span className="block truncate">{info.row.original.email}</span>;
const statusCell = (info: CellContext<Employee>) => (
  <Badge size="sm" variant={info.row.original.active ? 'success' : 'outline'}>
    {info.getValue<string>()}
  </Badge>
);
const noCell = () => null;

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
}: {
  readonly departments: readonly string[];
  readonly filters: EmployeeFilters;
  readonly onChange: (patch: Partial<EmployeeFilters>) => void;
}) => {
  const { t } = useModernI18n();
  const roleItems = [
    { label: t(`${key}.filters.allRoles`), value: allOption },
    ...employeeRoles.map((role) => ({ label: t(`${key}.roles.${role}`), value: role })),
  ];
  const departmentItems = [
    { label: t(`${key}.filters.allDepartments`), value: allOption },
    ...departments.map((department) => ({ label: department, value: department })),
  ];
  return (
    <div className="flex flex-wrap items-end gap-200">
      <Input
        aria-label={t(`${key}.filters.searchLabel`)}
        className="min-w-64 flex-1"
        onChange={(event) => onChange({ query: event.target.value })}
        placeholder={t(`${key}.filters.search`)}
        size="sm"
        type="search"
        value={filters.query}
      />
      <SelectTemplate
        items={roleItems}
        label={t(`${key}.filters.role`)}
        name="roleFilter"
        onValueChange={(details) => onChange({ role: roleFromValue(details.value[0]) })}
        size="sm"
        value={[filters.role ?? allOption]}
      />
      <SelectTemplate
        items={departmentItems}
        label={t(`${key}.filters.department`)}
        name="departmentFilter"
        onValueChange={(details) => onChange({ department: departmentFromValue(details.value[0]) })}
        size="sm"
        value={[filters.department ?? allOption]}
      />
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
}: {
  readonly busy: boolean;
  readonly count: number;
  readonly onClear: () => void;
  readonly onDepartment: () => void;
  readonly onRole: () => void;
  readonly onSetActive: (active: boolean) => void;
}) => {
  const { t } = useModernI18n();
  return (
    <BulkActionBar onClear={onClear} selectedCount={count}>
      <Button disabled={busy} onClick={onDepartment} size="sm" theme="outlined" variant="secondary">
        {t(`${key}.bulk.department`)}
      </Button>
      <Button disabled={busy} onClick={onRole} size="sm" theme="outlined" variant="secondary">
        {t(`${key}.bulk.role`)}
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
  );
};

const EmployeesPageContent = () => {
  const { t } = useModernI18n();
  const toaster = useToast();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [filters, setFilters] = useState<EmployeeFilters>(noFilters);
  const [selection, setSelection] = useState<Selection>({});
  const [form, setForm] = useState<{ readonly employee: Employee | null } | null>(null);
  const [bulk, setBulk] = useState<BulkDialogKind | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  useEffect(() => {
    loadEmployees(setState);
  }, []);

  const reload = () => loadEmployees(setState);

  /** Sends one command on the revision the page last read. A conflict or a success reloads the list. */
  const commit: CommitCommand = (build, successKey) => {
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
        onFailure: (error): CommitOutcome =>
          Match.value(error).pipe(
            Match.tag('ApplyCommandActionConflictProblem', (problem): CommitOutcome =>
              problem.code === 'workforce_revision_conflict' ? 'conflict' : 'failed',
            ),
            Match.tag('ApplyCommandActionForbiddenProblem', (): CommitOutcome => 'forbidden'),
            Match.orElse((): CommitOutcome => 'failed'),
          ),
        onSuccess: (): CommitOutcome => 'saved',
      }),
      Effect.tap((outcome) =>
        Effect.sync(() => {
          if (outcome === 'saved') {
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
  const visible = filterEmployees(sortEmployees(items), filters);
  const selectedIds = items.flatMap((employee) => (selection[employee.id] === true ? [employee.id] : []));

  /** Any filter change clears the selection so a bulk action never reaches rows the user cannot see. */
  const updateFilters = (patch: Partial<EmployeeFilters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setSelection({});
  };

  const bulkSetActive = (active: boolean) => {
    setBulkBusy(true);
    void browserRuntime.runPromise(
      commit(Effect.succeed(bulkCommand(selectedIds, { active })), `${key}.toast.bulkSaved`).pipe(
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

  const columns: ColumnDef<Employee>[] = [
    { accessorKey: 'fullName', cell: nameCell, header: t(`${key}.columns.name`), meta: { width: 220 } },
    { accessorKey: 'email', cell: emailCell, header: t(`${key}.columns.email`), meta: { width: 260 } },
    {
      accessorFn: (row) => t(`${key}.roles.${row.role}`),
      header: t(`${key}.columns.role`),
      id: 'role',
      meta: { width: 180 },
    },
    { accessorKey: 'department', header: t(`${key}.columns.department`), meta: { width: 180 } },
    {
      accessorFn: (row) => t(row.active ? `${key}.status.active` : `${key}.status.inactive`),
      cell: statusCell,
      header: t(`${key}.columns.status`),
      id: 'status',
      meta: { width: 130 },
    },
    {
      accessorFn: (row) => t(row.principalRef === undefined ? `${key}.account.none` : `${key}.account.linked`),
      header: t(`${key}.columns.account`),
      id: 'account',
      meta: { width: 140 },
    },
    { cell: noCell, enableSorting: false, header: t(`${key}.columns.tags`), id: 'tags', meta: { width: 200 } },
  ];

  const translations: DataTableTranslations = {
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
    if (hasActiveFilters(filters)) {
      return (
        <EmptyState
          action={
            <Button onClick={() => updateFilters(noFilters)} size="sm" theme="outlined" variant="secondary">
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

        <EmployeeFilterBar departments={departmentsOf(items)} filters={filters} onChange={updateFilters} />

        {canWrite && (
          <EmployeeBulkBar
            busy={bulkBusy}
            count={selectedIds.length}
            onClear={() => setSelection({})}
            onDepartment={() => setBulk('department')}
            onRole={() => setBulk('role')}
            onSetActive={bulkSetActive}
          />
        )}

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
          loading={state.status === 'loading'}
          loadingRowCount={10}
          maxHeight="calc(100dvh - 15rem)"
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
      </div>

      {form !== null && <EmployeeFormDialog commit={commit} employee={form.employee} onClose={() => setForm(null)} />}
      {bulk === 'department' && (
        <BulkDepartmentDialog commit={commit} ids={selectedIds} onClose={() => setBulk(null)} onSaved={afterBulkSave} />
      )}
      {bulk === 'role' && (
        <BulkRoleDialog commit={commit} ids={selectedIds} onClose={() => setBulk(null)} onSaved={afterBulkSave} />
      )}
    </>
  );
};

export const EmployeesPage = () => {
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
