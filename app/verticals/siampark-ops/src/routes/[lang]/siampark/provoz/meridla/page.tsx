// Siampark provoz — meters. OWNED BY THE `meters` LANE: replace this scaffold page freely.
// Data: useAgendaRecords(['meters']) / ScaffoldRecordView; commands: shared/commands/meters.ts.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import type { OpsCommand } from '../../../../../../shared/agendas.ts';
import type { Meter, MetersState } from '../../../../../../shared/domain/meters.ts';
import { AgendaFrame } from '../../../../../ui/agenda-frame.tsx';
import { ScaffoldRecordView, locationLabel } from '../../../../../ui/scaffold-record-page.tsx';
import { UltramodernRouteHead } from '../../../../ultramodern-route-head';

const MetersView = () => {
  const { t } = useModernI18n();
  return (
    <ScaffoldRecordView<Meter>
      agenda="meters"
      columns={[
      { cell: (row) => row.serialNumber ?? t('siampark-ops.common.notProvided'), header: t('siampark-ops.meters.fields.serialNumber'), id: 'serialNumber' },
      { cell: (row) => t(`siampark-ops.meters.medium.${row.medium}`), header: t('siampark-ops.meters.fields.medium'), id: 'medium' },
      { cell: (row) => row.unit ?? t('siampark-ops.common.notProvided'), header: t('siampark-ops.meters.fields.unit'), id: 'unit' },
      { cell: (row) => locationLabel(row.location, t('siampark-ops.common.noData')), header: t('siampark-ops.common.location'), id: 'location' },
      ]}
      fields={[
      { kind: 'text', label: t('siampark-ops.meters.fields.serialNumber'), name: 'serialNumber', required: true },
      { kind: 'select', label: t('siampark-ops.meters.fields.medium'), name: 'medium', options: ["ELECTRICITY", "WATER", "GAS", "HEAT"].map((value) => ({ label: t(`siampark-ops.meters.medium.${value}`), value })), required: true },
      { kind: 'text', label: t('siampark-ops.meters.fields.unit'), name: 'unit', required: true },
      ]}
      rowLabel={(row) => row.serialNumber}
      rows={(state) => (state as MetersState).meters}
      toCommand={(values, location) => ({
        _tag: 'MeterCreate',
        serialNumber: values['serialNumber'] ?? '',
        medium: values['medium'] as Extract<OpsCommand, { _tag: 'MeterCreate' }>['medium'],
        unit: values['unit'] ?? '',
        ...(location === undefined ? {} : { location: location }),
      }) as OpsCommand}
    />
  );
};

export const MetersPage = () => (
  <AgendaFrame>
    <UltramodernRouteHead titleKey="siampark-ops.meters.title" />
    <MetersView />
  </AgendaFrame>
);

export default MetersPage;
