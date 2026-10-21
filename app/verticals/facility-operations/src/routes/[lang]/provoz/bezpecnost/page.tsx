// @effect-diagnostics asyncFunction:off
// Facility operations — S11 Evidence bezpečnostních zařízení. OWNED BY THE `security` LANE.
// Restricted agenda: the server returns no state without facility.operations.read_all (external persona → forbidden).
import { EmptyState, PageHeader, StatCard, StatRow, formatDate, surfaceTileClassName } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Input } from '@techsio/ui-kit/atoms/input';
import { Switch } from '@techsio/ui-kit/molecules/switch';
import { Tabs } from '@techsio/ui-kit/molecules/tabs';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import type { ColumnDef } from '@techsio/ui-kit/organisms/data-table';
import { SelectTemplate as Select } from '@techsio/ui-kit/templates/select';
import { useEffect, useState } from 'react';
import { isInspectionOverdue } from '../../../../../../shared/commands/security.ts';
import { isOpenIncident, securityDeviceStates, securityDeviceTypes } from '../../../../../../shared/domain/security.ts';
import type { SecurityDevice, SecurityIncident, SecurityState } from '../../../../../../shared/domain/security.ts';
import { AgendaFrame, AgendaGate } from '../../../../../ui/agenda-frame.tsx';
import { useAgendaRecords } from '../../../../../ui/use-agenda.ts';
import { UltramodernRouteHead } from '../../../../ultramodern-route-head';
import { DeviceDetailPanel } from './device-detail.tsx';
import { DeviceFormPanel, InspectionPanel, ReportFaultPanel, ResolvePanel } from './device-forms.tsx';
import {
  deviceStateVariant,
  deviceTypeIcon,
  incidentStateVariant,
  locationText,
  personaName,
  severityVariant,
  todayPrague,
  useSecurityLabel,
} from './security-model.ts';

type Panel =
  | { readonly kind: 'none' }
  | { readonly kind: 'detail'; readonly deviceId: string }
  | { readonly kind: 'create' }
  | { readonly kind: 'edit'; readonly deviceId: string }
  | { readonly kind: 'inspection'; readonly deviceId: string }
  | { readonly kind: 'report'; readonly deviceId: string | undefined }
  | { readonly kind: 'resolve'; readonly deviceId: string; readonly incidentId: string };

const ALL = 'all';
const emptyState: SecurityState = { devices: [], incidents: [] };

const SecurityView = () => {
  const k = useSecurityLabel();
  const { t } = useModernI18n();
  const ops = useAgendaRecords(['security']);
  const envelope = ops.data?.agendas.security;
  const state = (envelope?.state as SecurityState | undefined) ?? emptyState;
  const devices = state.devices;
  const incidents = state.incidents ?? [];
  const canWrite = envelope?.canWrite === true;
  const tenantId = ops.data?.actorPrincipalRef.tenantId ?? '';
  const [tab, setTab] = useState('devices');
  const [panel, setPanel] = useState<Panel>({ kind: 'none' });
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState(ALL);
  const [stateFilter, setStateFilter] = useState(ALL);
  const [openOnly, setOpenOnly] = useState(true);
  const today = todayPrague();

  // Service-task descriptions link back to the exact device, without bypassing the agenda access gate.
  useEffect(() => {
    const deviceId = new URLSearchParams(window.location.search).get('device');
    if (deviceId !== null && deviceId !== '') {
      setPanel({ kind: 'detail', deviceId });
    }
  }, []);

  const openIncidentsOf = (deviceId: string) =>
    incidents.filter((incident) => incident.deviceId === deviceId && isOpenIncident(incident));
  const deviceById = (deviceId: string) => devices.find((device) => device.id === deviceId);
  const backToDetail = (deviceId: string | undefined) =>
    setPanel(deviceId === undefined ? { kind: 'none' } : { kind: 'detail', deviceId });

  const needle = search.trim().toLocaleLowerCase('cs');
  const filtered = devices.filter(
    (device) =>
      (typeFilter === ALL || device.deviceType === typeFilter) &&
      (stateFilter === ALL || device.state === stateFilter) &&
      (needle === '' ||
        [
          device.name,
          device.serialNumber,
          device.location?.label,
          device.locationDetail,
          device.administrator,
          device.supplier,
        ]
          .filter((value) => value !== undefined)
          .some((value) => value.toLocaleLowerCase('cs').includes(needle))),
  );
  const filtersActive = needle !== '' || typeFilter !== ALL || stateFilter !== ALL;
  const shownIncidents = incidents
    .filter((incident) => !openOnly || isOpenIncident(incident))
    .toSorted((left, right) => right.occurredOn.localeCompare(left.occurredOn));

  const active = devices.filter((device) => device.state !== 'decommissioned');
  const openIncidents = incidents.filter(isOpenIncident);
  const stats = {
    critical: openIncidents.filter((incident) => incident.severity === 'high' || incident.severity === 'critical')
      .length,
    faulty: devices.filter((device) => device.state === 'fault').length,
    overdue: devices.filter((device) => isInspectionOverdue(device, today)).length,
  };

  const deviceColumns: ColumnDef<SecurityDevice>[] = [
    {
      accessorKey: 'name',
      cell: ({ row }) => (
        <span className="flex min-w-0 items-center gap-150">
          <span
            aria-hidden
            className={`${deviceTypeIcon(row.original.deviceType)} size-5 shrink-0 text-fg-secondary`}
          />
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium" title={row.original.name}>{row.original.name}</span>
            <span className="truncate text-fg-secondary text-xs">
              {k(`deviceType.${row.original.deviceType}`)}
              {row.original.serialNumber === undefined ? '' : ` · ${row.original.serialNumber}`}
            </span>
          </span>
        </span>
      ),
      header: k('fields.name'),
      meta: { width: 260 },
    },
    {
      cell: ({ row }) => (
        <span className="line-clamp-2 text-sm">{locationText(row.original, t('facility-operations.common.notProvided'))}</span>
      ),
      header: k('fields.location'),
      id: 'location',
      meta: { width: 260 },
    },
    {
      accessorKey: 'state',
      cell: ({ row }) => (
        <Badge size="sm" variant={deviceStateVariant(row.original.state)}>
          {k(`state.${row.original.state}`)}
        </Badge>
      ),
      header: k('fields.state'),
      meta: { width: 120 },
    },
    {
      cell: ({ row }) => {
        const count = openIncidentsOf(row.original.id).length;
        return count === 0 ? (
          <span className="text-fg-secondary">0</span>
        ) : (
          <Badge size="sm" variant="danger">
            {String(count)}
          </Badge>
        );
      },
      header: k('fields.openIncidents'),
      id: 'openIncidents',
      meta: { width: 150 },
    },
    {
      accessorKey: 'nextInspectionDate',
      cell: ({ row }) => {
        const next = row.original.nextInspectionDate;
        if (next === undefined) {
          return <span className="text-fg-secondary">{t('facility-operations.common.notProvided')}</span>;
        }
        return isInspectionOverdue(row.original, today) ? (
          <span className="flex flex-col">
            <span className="font-semibold text-fg-danger">{formatDate(next)}</span>
            <span className="text-fg-danger text-xs">{k('detail.overdue')}</span>
          </span>
        ) : (
          formatDate(next)
        );
      },
      header: k('fields.nextInspectionDate'),
      meta: { width: 140 },
    },
    {
      cell: ({ row }) => (
        <span className="truncate text-sm">{row.original.administrator ?? t('facility-operations.common.notProvided')}</span>
      ),
      header: k('fields.administrator'),
      id: 'administrator',
      meta: { width: 190 },
    },
  ];

  const incidentColumns: ColumnDef<SecurityIncident>[] = [
    {
      accessorKey: 'title',
      cell: ({ row }) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{row.original.title}</span>
          <span className="truncate text-fg-secondary text-xs">{deviceById(row.original.deviceId)?.name ?? '—'}</span>
        </span>
      ),
      header: k('fields.title'),
      meta: { width: 280 },
    },
    {
      accessorKey: 'severity',
      cell: ({ row }) => (
        <Badge size="sm" variant={severityVariant(row.original.severity)}>
          {k(`severity.${row.original.severity}`)}
        </Badge>
      ),
      header: k('fields.severity'),
      meta: { width: 110 },
    },
    {
      accessorKey: 'state',
      cell: ({ row }) => (
        <Badge size="sm" variant={incidentStateVariant(row.original.state)}>
          {k(`incidentState.${row.original.state}`)}
        </Badge>
      ),
      header: k('fields.incidentState'),
      meta: { width: 120 },
    },
    {
      accessorKey: 'occurredOn',
      cell: ({ row }) => (
        <span className="flex flex-col">
          <span>{formatDate(row.original.occurredOn)}</span>
          <span className="text-fg-secondary text-xs">{personaName(k, row.original.createdBy)}</span>
        </span>
      ),
      header: k('fields.occurredOn'),
      meta: { width: 150 },
    },
    {
      cell: ({ row }) =>
        row.original.task === undefined ? (
          <span className="text-fg-secondary text-sm">{k('detail.taskMissing')}</span>
        ) : (
          <span className="flex min-w-0 items-center gap-50 text-sm">
            <span aria-hidden className="icon-[mdi--clipboard-check-outline] size-5 shrink-0 text-fg-secondary" />
            <span className="truncate">{row.original.task.title}</span>
          </span>
        ),
      header: k('fields.task'),
      id: 'task',
      meta: { width: 280 },
    },
  ];

  const tableText = {
    emptyDescription: filtersActive ? '' : k('states.emptyDescription'),
    emptyTitle: filtersActive ? k('states.noResults') : k('states.empty'),
  };

  const panelDevice =
    panel.kind === 'detail' || panel.kind === 'edit' || panel.kind === 'inspection' || panel.kind === 'resolve'
      ? deviceById(panel.deviceId)
      : undefined;
  const resolveIncident =
    panel.kind === 'resolve' ? incidents.find((incident) => incident.id === panel.incidentId) : undefined;
  const afterSave = (deviceId: string | undefined) => {
    void ops.reload();
    backToDetail(deviceId);
  };

  return (
    <>
      <PageHeader
        actions={
          canWrite ? (
            <div className="flex flex-wrap items-center gap-100">
              <Button
                icon="icon-[mdi--alert-outline]"
                onClick={() => setPanel({ deviceId: undefined, kind: 'report' })}
                size="sm"
                theme="outlined"
                variant="secondary"
              >
                {k('actions.reportFault')}
              </Button>
              <Button icon="icon-[mdi--plus]" onClick={() => setPanel({ kind: 'create' })} size="sm" variant="primary">
                {k('actions.newDevice')}
              </Button>
            </div>
          ) : undefined
        }
        description={k('description')}
        title={k('title')}
      />
      <AgendaGate onRetry={() => void ops.reload()} readable={envelope !== undefined} status={ops.status}>
        <div className={`${surfaceTileClassName} flex flex-wrap items-center gap-100 px-200 py-150 text-sm`}>
          <span aria-hidden className="icon-[mdi--shield-check-outline] size-5 text-fg-secondary" />
          <Badge size="sm" variant="info">
            {k('evidenceOnly')}
          </Badge>
          <span className="text-fg-secondary">{k('evidenceOnlyHint')}</span>
          <span className="text-fg-secondary">·</span>
          <span className="text-fg-secondary">{k('restrictedHint')}</span>
        </div>
        <StatRow>
          <StatCard
            hint={k('stats.countSummary', { active: active.length, retired: devices.length - active.length })}
            label={k('stats.count')}
            value={String(devices.length)}
          />
          <StatCard
            hint={k('stats.openIncidentsHint', { critical: stats.critical })}
            label={k('stats.openIncidents')}
            value={String(openIncidents.length)}
          />
          <StatCard label={k('stats.faulty')} value={String(stats.faulty)} />
          <StatCard hint={k('stats.overdueHint')} label={k('stats.overdue')} value={String(stats.overdue)} />
        </StatRow>
        <Tabs onValueChange={setTab} size="sm" value={tab} variant="line">
          <Tabs.List>
            <Tabs.Trigger value="devices">
              {k('tabs.devices')} ({devices.length})
            </Tabs.Trigger>
            <Tabs.Trigger value="incidents">
              {k('tabs.incidents')} ({openIncidents.length})
            </Tabs.Trigger>
            <Tabs.Indicator />
          </Tabs.List>
          <Tabs.Content className="flex flex-col gap-200 pt-200" value="devices">
            <div className="flex flex-wrap items-end gap-150">
              <Input
                aria-label={k('filters.search')}
                className="w-80"
                onChange={(event) => setSearch(event.target.value)}
                placeholder={k('filters.search')}
                size="sm"
                type="search"
                value={search}
              />
              <div className="w-48">
                <Select
                  items={[
                    { label: k('filters.allTypes'), value: ALL },
                    ...securityDeviceTypes.map((value) => ({ label: k(`deviceType.${value}`), value })),
                  ]}
                  label={k('fields.deviceType')}
                  name="typeFilter"
                  onValueChange={({ value }) => setTypeFilter(value[0] ?? ALL)}
                  size="sm"
                  value={[typeFilter]}
                />
              </div>
              <div className="w-48">
                <Select
                  items={[
                    { label: k('filters.allStates'), value: ALL },
                    ...securityDeviceStates.map((value) => ({ label: k(`state.${value}`), value })),
                  ]}
                  label={k('fields.state')}
                  name="stateFilter"
                  onValueChange={({ value }) => setStateFilter(value[0] ?? ALL)}
                  size="sm"
                  value={[stateFilter]}
                />
              </div>
              {filtersActive && (
                <Button
                  onClick={() => {
                    setSearch('');
                    setTypeFilter(ALL);
                    setStateFilter(ALL);
                  }}
                  size="sm"
                  theme="borderless"
                  variant="secondary"
                >
                  {k('actions.clearFilters')}
                </Button>
              )}
            </div>
            <DataTable
              columns={deviceColumns}
              data={[...filtered]}
              enableSorting
              getRowId={(row) => row.id}
              getRowLabel={(row) => row.original.name}
              loading={false}
              onRowClick={(row) => setPanel({ deviceId: row.original.id, kind: 'detail' })}
              renderEmpty={() => <EmptyState description={tableText.emptyDescription} title={tableText.emptyTitle} />}
              size="sm"
              tableLayout="fixed"
              translations={tableText}
            />
          </Tabs.Content>
          <Tabs.Content className="flex flex-col gap-200 pt-200" value="incidents">
            <Switch checked={openOnly} name="openOnly" onCheckedChange={setOpenOnly}>
              {k('filters.openOnly')}
            </Switch>
            <DataTable
              columns={incidentColumns}
              data={[...shownIncidents]}
              enableSorting
              getRowId={(row) => row.id}
              getRowLabel={(row) => row.original.title}
              loading={false}
              onRowClick={(row) => setPanel({ deviceId: row.original.deviceId, kind: 'detail' })}
              renderEmpty={() => <EmptyState title={k('states.noIncidents')} />}
              size="sm"
              tableLayout="fixed"
              translations={{ emptyDescription: '', emptyTitle: k('states.noIncidents') }}
            />
          </Tabs.Content>
        </Tabs>
      </AgendaGate>

      {panel.kind === 'detail' && (
        <DeviceDetailPanel
          canWrite={canWrite}
          device={panelDevice}
          incidents={incidents}
          onClose={() => setPanel({ kind: 'none' })}
          onEdit={() => setPanel({ deviceId: panel.deviceId, kind: 'edit' })}
          onInspection={() => setPanel({ deviceId: panel.deviceId, kind: 'inspection' })}
          onReload={ops.reload}
          onReport={() => setPanel({ deviceId: panel.deviceId, kind: 'report' })}
          onResolve={(incident) => setPanel({ deviceId: panel.deviceId, incidentId: incident.id, kind: 'resolve' })}
          revision={envelope?.revision ?? 0}
          run={ops.run}
          tenantId={tenantId}
        />
      )}
      <DeviceFormPanel
        device={panel.kind === 'edit' ? panelDevice : undefined}
        onClose={() => backToDetail(panel.kind === 'edit' ? panel.deviceId : undefined)}
        onSaved={(deviceId) => afterSave(panel.kind === 'edit' ? panel.deviceId : deviceId)}
        open={panel.kind === 'create' || panel.kind === 'edit'}
        run={ops.run}
      />
      <ReportFaultPanel
        devices={devices}
        initialDeviceId={panel.kind === 'report' ? panel.deviceId : undefined}
        onClose={() => backToDetail(panel.kind === 'report' ? panel.deviceId : undefined)}
        onSaved={(deviceId) => afterSave(deviceId)}
        open={panel.kind === 'report'}
        run={ops.run}
        tenantId={tenantId}
      />
      <InspectionPanel
        device={panel.kind === 'inspection' ? panelDevice : undefined}
        onClose={() => backToDetail(panel.kind === 'inspection' ? panel.deviceId : undefined)}
        onSaved={() => afterSave(panel.kind === 'inspection' ? panel.deviceId : undefined)}
        open={panel.kind === 'inspection'}
        run={ops.run}
      />
      <ResolvePanel
        incident={resolveIncident}
        onClose={() => backToDetail(panel.kind === 'resolve' ? panel.deviceId : undefined)}
        onSaved={() => afterSave(panel.kind === 'resolve' ? panel.deviceId : undefined)}
        open={panel.kind === 'resolve'}
        run={ops.run}
      />
    </>
  );
};

export const SecurityPage = () => (
  <AgendaFrame>
    <UltramodernRouteHead titleKey="facility-operations.security.title" />
    <SecurityView />
  </AgendaFrame>
);

export default SecurityPage;
