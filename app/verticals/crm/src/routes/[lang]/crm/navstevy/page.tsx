// AREA: visits — owned by the crm-visits lane. Scaffold version: minimal working page.
import { EmptyState, PageHeader, StatCard, StatRow, formatNumber } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { CrmPage } from '../../../../crm/crm-page.tsx';
import { useCrmRecords } from '../../../../crm/records.ts';
import { CrmScopeNote, CrmStateGate } from '../../../../crm/ui.tsx';

const VisitsContent = () => {
  const { t } = useModernI18n();
  const { load, state } = useCrmRecords();
  return (
    <CrmStateGate onRetry={load} state={state}>
      {(records) => (
        <>
          <PageHeader description={t('crm.pages.visits.description')} title={t('crm.pages.visits.title')} />
          <StatRow>
            <StatCard label="Zapsané návštěvy" value={formatNumber(records.state.visits.items.length)} />
          </StatRow>
          <CrmScopeNote records={records} />
          {records.state.visits.items.length === 0 ? <EmptyState title="Zatím žádné záznamy" /> : null}
        </>
      )}
    </CrmStateGate>
  );
};

export const VisitsPage = () => (
  <CrmPage titleKey="crm.pages.visits.title">
    <VisitsContent />
  </CrmPage>
);

export default VisitsPage;
