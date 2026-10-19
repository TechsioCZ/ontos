// Siampark provoz — security. OWNED BY THE `security` LANE: replace this scaffold page freely.
// Data: useAgendaRecords(['security']) / ScaffoldRecordView; commands: shared/commands/security.ts.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import type { OpsCommand } from '../../../../../../shared/agendas.ts';
import type { SecurityDevice, SecurityState } from '../../../../../../shared/domain/security.ts';
import { AgendaFrame } from '../../../../../ui/agenda-frame.tsx';
import { ScaffoldRecordView, locationLabel } from '../../../../../ui/scaffold-record-page.tsx';
import { UltramodernRouteHead } from '../../../../ultramodern-route-head';

const SecurityView = () => {
  const { t } = useModernI18n();
  return (
    <ScaffoldRecordView<SecurityDevice>
      agenda="security"
      columns={[
      { cell: (row) => row.name ?? t('siampark-ops.common.notProvided'), header: t('siampark-ops.security.fields.name'), id: 'name' },
      { cell: (row) => row.deviceType ?? t('siampark-ops.common.notProvided'), header: t('siampark-ops.security.fields.deviceType'), id: 'deviceType' },
      { cell: (row) => row.nextInspectionDate ?? t('siampark-ops.common.notProvided'), header: t('siampark-ops.security.fields.nextInspectionDate'), id: 'nextInspectionDate' },
      { cell: (row) => locationLabel(row.location, t('siampark-ops.common.noData')), header: t('siampark-ops.common.location'), id: 'location' },
      ]}
      fields={[
      { kind: 'text', label: t('siampark-ops.security.fields.name'), name: 'name', required: true },
      { kind: 'text', label: t('siampark-ops.security.fields.deviceType'), name: 'deviceType', required: true },
      { kind: 'date', label: t('siampark-ops.security.fields.nextInspectionDate'), name: 'nextInspectionDate' },
      ]}
      rowLabel={(row) => row.name}
      rows={(state) => (state as SecurityState).devices}
      toCommand={(values, location) => ({
        _tag: 'SecurityDeviceCreate',
        name: values['name'] ?? '',
        deviceType: values['deviceType'] ?? '',
        ...(values['nextInspectionDate'] === undefined ? {} : { nextInspectionDate: values['nextInspectionDate'] }),
        ...(location === undefined ? {} : { location: location }),
      }) as OpsCommand}
    />
  );
};

export const SecurityPage = () => (
  <AgendaFrame>
    <UltramodernRouteHead titleKey="siampark-ops.security.title" />
    <SecurityView />
  </AgendaFrame>
);

export default SecurityPage;
