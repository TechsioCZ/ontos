// Siampark provoz — assets. OWNED BY THE `assets` LANE: replace this scaffold page freely.
// Data: useAgendaRecords(['assets']) / ScaffoldRecordView; commands: shared/commands/assets.ts.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import type { OpsCommand } from '../../../../../../shared/agendas.ts';
import type { Asset, AssetsState } from '../../../../../../shared/domain/assets.ts';
import { AgendaFrame } from '../../../../../ui/agenda-frame.tsx';
import { ScaffoldRecordView, locationLabel } from '../../../../../ui/scaffold-record-page.tsx';
import { UltramodernRouteHead } from '../../../../ultramodern-route-head';

const AssetsView = () => {
  const { t } = useModernI18n();
  return (
    <ScaffoldRecordView<Asset>
      agenda="assets"
      columns={[
      { cell: (row) => row.inventoryNumber ?? t('siampark-ops.common.notProvided'), header: t('siampark-ops.assets.fields.inventoryNumber'), id: 'inventoryNumber' },
      { cell: (row) => row.name ?? t('siampark-ops.common.notProvided'), header: t('siampark-ops.assets.fields.name'), id: 'name' },
      { cell: (row) => row.category ?? t('siampark-ops.common.notProvided'), header: t('siampark-ops.assets.fields.category'), id: 'category' },
      { cell: (row) => locationLabel(row.location, t('siampark-ops.common.noData')), header: t('siampark-ops.common.location'), id: 'location' },
      ]}
      fields={[
      { kind: 'text', label: t('siampark-ops.assets.fields.inventoryNumber'), name: 'inventoryNumber', required: true },
      { kind: 'text', label: t('siampark-ops.assets.fields.name'), name: 'name', required: true },
      { kind: 'text', label: t('siampark-ops.assets.fields.category'), name: 'category', required: true },
      ]}
      rowLabel={(row) => row.name}
      rows={(state) => (state as AssetsState).assets}
      toCommand={(values, location) => ({
        _tag: 'AssetCreate',
        inventoryNumber: values['inventoryNumber'] ?? '',
        name: values['name'] ?? '',
        category: values['category'] ?? '',
        ...(location === undefined ? {} : { location: location }),
      }) as OpsCommand}
    />
  );
};

export const AssetsPage = () => (
  <AgendaFrame>
    <UltramodernRouteHead titleKey="siampark-ops.assets.title" />
    <AssetsView />
  </AgendaFrame>
);

export default AssetsPage;
