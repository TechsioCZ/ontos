// Siampark provoz — purchasing. OWNED BY THE `purchasing` LANE: replace this scaffold page freely.
// Data: useAgendaRecords(['purchasing']) / ScaffoldRecordView; commands: shared/commands/purchasing.ts.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import type { OpsCommand } from '../../../../../../shared/agendas.ts';
import type { StockItem, PurchasingState } from '../../../../../../shared/domain/purchasing.ts';
import { AgendaFrame } from '../../../../../ui/agenda-frame.tsx';
import { ScaffoldRecordView, locationLabel } from '../../../../../ui/scaffold-record-page.tsx';
import { UltramodernRouteHead } from '../../../../ultramodern-route-head';

const PurchasingView = () => {
  const { t } = useModernI18n();
  return (
    <ScaffoldRecordView<StockItem>
      agenda="purchasing"
      columns={[
      { cell: (row) => row.sku ?? t('siampark-ops.common.notProvided'), header: t('siampark-ops.purchasing.fields.sku'), id: 'sku' },
      { cell: (row) => row.name ?? t('siampark-ops.common.notProvided'), header: t('siampark-ops.purchasing.fields.name'), id: 'name' },
      { cell: (row) => row.unit ?? t('siampark-ops.common.notProvided'), header: t('siampark-ops.purchasing.fields.unit'), id: 'unit' },
      { cell: (row) => locationLabel(row.location, t('siampark-ops.common.noData')), header: t('siampark-ops.common.location'), id: 'location' },
      ]}
      fields={[
      { kind: 'text', label: t('siampark-ops.purchasing.fields.sku'), name: 'sku', required: true },
      { kind: 'text', label: t('siampark-ops.purchasing.fields.name'), name: 'name', required: true },
      { kind: 'text', label: t('siampark-ops.purchasing.fields.unit'), name: 'unit', required: true },
      ]}
      rowLabel={(row) => row.name}
      rows={(state) => (state as PurchasingState).items}
      toCommand={(values, location) => ({
        _tag: 'StockItemCreate',
        sku: values['sku'] ?? '',
        name: values['name'] ?? '',
        unit: values['unit'] ?? '',
        ...(location === undefined ? {} : { location: location }),
      }) as OpsCommand}
    />
  );
};

export const PurchasingPage = () => (
  <AgendaFrame>
    <UltramodernRouteHead titleKey="siampark-ops.purchasing.title" />
    <PurchasingView />
  </AgendaFrame>
);

export default PurchasingPage;
