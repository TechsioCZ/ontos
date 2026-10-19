// AREA: visits — owned by the crm-visits lane. Scaffold version: minimal working page.
import { EmptyState, PageHeader, StatCard, StatRow, formatNumber } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { CrmPage } from '../../../../crm/crm-page.tsx';
import { useCrmRecords } from '../../../../crm/records.ts';
import { CrmScopeNote, CrmStateGate } from '../../../../crm/ui.tsx';

const PlanContent = () => {
  const { t } = useModernI18n();
  const { load, state } = useCrmRecords();
  return (
    <CrmStateGate onRetry={load} state={state}>
      {(records) => (
        <>
          <PageHeader description={t('crm.pages.plan.description')} title={t('crm.pages.plan.title')} />
          <StatRow>
            <StatCard
              label="Otevřené kontakty"
              value={formatNumber(records.state.visits.plan.filter((item) => item.status === 'open').length)}
            />
          </StatRow>
          <CrmScopeNote records={records} />
          {records.state.visits.plan.filter((item) => item.status === 'open').length === 0 ? (
            <EmptyState title="Zatím žádné záznamy" />
          ) : null}
        </>
      )}
    </CrmStateGate>
  );
};

export const PlanPage = () => (
  <CrmPage titleKey="crm.pages.plan.title">
    <PlanContent />
  </CrmPage>
);

export default PlanPage;
