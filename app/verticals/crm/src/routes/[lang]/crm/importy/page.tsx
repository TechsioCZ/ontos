// AREA: imports — owned by the crm-imports lane. Scaffold version: minimal working page.
import { EmptyState, PageHeader, StatCard, StatRow, formatNumber } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { CrmPage } from '../../../../crm/crm-page.tsx';
import { useCrmRecords } from '../../../../crm/records.ts';
import { CrmScopeNote, CrmStateGate } from '../../../../crm/ui.tsx';

const ImportsContent = () => {
  const { t } = useModernI18n();
  const { load, state } = useCrmRecords();
  return (
    <CrmStateGate onRetry={load} state={state}>
      {(records) => (
        <>
          <PageHeader description={t('crm.pages.imports.description')} title={t('crm.pages.imports.title')} />
          <StatRow>
            <StatCard label="Importní dávky" value={formatNumber(records.state.imports.batches.length)} />
          </StatRow>
          <CrmScopeNote records={records} />
          {records.state.imports.batches.length === 0 ? <EmptyState title="Zatím žádné záznamy" /> : null}
        </>
      )}
    </CrmStateGate>
  );
};

export const ImportsPage = () => (
  <CrmPage titleKey="crm.pages.imports.title">
    <ImportsContent />
  </CrmPage>
);

export default ImportsPage;
