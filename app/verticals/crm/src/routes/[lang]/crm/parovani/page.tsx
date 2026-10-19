// AREA: imports — owned by the crm-imports lane. Scaffold version: minimal working page.
import { EmptyState, PageHeader, StatCard, StatRow, formatNumber } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { CrmPage } from '../../../../crm/crm-page.tsx';
import { useCrmRecords } from '../../../../crm/records.ts';
import { CrmScopeNote, CrmStateGate } from '../../../../crm/ui.tsx';

const PairingContent = () => {
  const { t } = useModernI18n();
  const { load, state } = useCrmRecords();
  return (
    <CrmStateGate onRetry={load} state={state}>
      {(records) => (
        <>
          <PageHeader description={t('crm.pages.pairing.description')} title={t('crm.pages.pairing.title')} />
          <StatRow>
            <StatCard
              label="K napárování"
              value={formatNumber(records.state.imports.orders.filter((order) => order.pairing !== 'paired').length)}
            />
          </StatRow>
          <CrmScopeNote records={records} />
          {records.state.imports.orders.filter((order) => order.pairing !== 'paired').length === 0 ? (
            <EmptyState title="Zatím žádné záznamy" />
          ) : null}
        </>
      )}
    </CrmStateGate>
  );
};

export const PairingPage = () => (
  <CrmPage titleKey="crm.pages.pairing.title">
    <PairingContent />
  </CrmPage>
);

export default PairingPage;
