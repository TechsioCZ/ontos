// Siampark provoz — agenda. OWNED BY THE `agenda` LANE: replace this scaffold page freely.
// Data: useAgendaRecords(['agenda']) / ScaffoldRecordView; commands: shared/commands/agenda.ts.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import type { OpsCommand } from '../../../../../../shared/agendas.ts';
import type { CalendarEvent, AgendaState } from '../../../../../../shared/domain/agenda.ts';
import { AgendaFrame } from '../../../../../ui/agenda-frame.tsx';
import { ScaffoldRecordView, locationLabel } from '../../../../../ui/scaffold-record-page.tsx';
import { UltramodernRouteHead } from '../../../../ultramodern-route-head';

const AgendaView = () => {
  const { t } = useModernI18n();
  return (
    <ScaffoldRecordView<CalendarEvent>
      agenda="agenda"
      columns={[
      { cell: (row) => row.date ?? t('siampark-ops.common.notProvided'), header: t('siampark-ops.agenda.fields.date'), id: 'date' },
      { cell: (row) => row.title ?? t('siampark-ops.common.notProvided'), header: t('siampark-ops.agenda.fields.title'), id: 'title' },
      { cell: (row) => t(`siampark-ops.agenda.kind.${row.kind}`), header: t('siampark-ops.agenda.fields.kind'), id: 'kind' },
      { cell: (row) => locationLabel(row.related, t('siampark-ops.common.noData')), header: t('siampark-ops.common.location'), id: 'location' },
      ]}
      fields={[
      { kind: 'text', label: t('siampark-ops.agenda.fields.title'), name: 'title', required: true },
      { kind: 'date', label: t('siampark-ops.agenda.fields.date'), name: 'date', required: true },
      { kind: 'select', label: t('siampark-ops.agenda.fields.kind'), name: 'kind', options: ["DEADLINE", "INSPECTION", "MEETING", "REMINDER"].map((value) => ({ label: t(`siampark-ops.agenda.kind.${value}`), value })), required: true },
      ]}
      rowLabel={(row) => row.title}
      rows={(state) => (state as AgendaState).events}
      toCommand={(values, location) => ({
        _tag: 'AgendaEventCreate',
        title: values['title'] ?? '',
        date: values['date'] ?? '',
        kind: values['kind'] as Extract<OpsCommand, { _tag: 'AgendaEventCreate' }>['kind'],
        ...(location === undefined ? {} : { related: location }),
      }) as OpsCommand}
    />
  );
};

export const AgendaPage = () => (
  <AgendaFrame>
    <UltramodernRouteHead titleKey="siampark-ops.agenda.title" />
    <AgendaView />
  </AgendaFrame>
);

export default AgendaPage;
