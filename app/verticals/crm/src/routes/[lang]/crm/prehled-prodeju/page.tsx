// AREA: reports — owned by the crm-reports lane. Scaffold version: minimal working page.
import { EmptyState, PageHeader, StatCard, StatRow, formatNumber } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { CrmPage } from '../../../../crm/crm-page.tsx';
import { useCrmRecords } from '../../../../crm/records.ts';
import { CrmScopeNote, CrmStateGate } from '../../../../crm/ui.tsx';

const ReportsContent = () => {
  const { t } = useModernI18n();
  const { load, state } = useCrmRecords();
  return (
    <CrmStateGate onRetry={load} state={state}>
      {(records) => (
        <>
          <PageHeader description={t('crm.pages.reports.description')} title={t('crm.pages.reports.title')} />
          <StatRow>
            <StatCard label="Evidované objednávky" value={formatNumber(records.state.imports.orders.length)} />
          </StatRow>
          <CrmScopeNote records={records} />
          {records.state.imports.orders.length === 0 ? <EmptyState title="Zatím žádné záznamy" /> : null}
        </>
      )}
    </CrmStateGate>
  );
};

export const ReportsPage = () => (
  <CrmPage titleKey="crm.pages.reports.title">
    <ReportsContent />
  </CrmPage>
);

export default ReportsPage;
