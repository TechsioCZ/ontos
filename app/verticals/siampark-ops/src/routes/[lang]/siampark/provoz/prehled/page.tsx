// Siampark provoz — přehled (S15). OWNED BY THE `agenda` LANE (S13 + S15). Scaffold: counts per readable agenda.
import { PageHeader, StatCard, StatRow } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { agendaIds } from '../../../../../../shared/agendas.ts';
import type { AgendaId } from '../../../../../../shared/domain/common.ts';
import { AgendaFrame, AgendaGate } from '../../../../../ui/agenda-frame.tsx';
import { useAgendaRecords } from '../../../../../ui/use-agenda.ts';
import { UltramodernRouteHead } from '../../../../ultramodern-route-head';

/** Record count of an agenda state: length of its first array field. */
const countOf = (state: unknown): number => {
  const first = Object.values(state as Record<string, unknown>).find(Array.isArray);
  return Array.isArray(first) ? first.length : 0;
};

const OverviewView = () => {
  const { t } = useModernI18n();
  const ops = useAgendaRecords(agendaIds);
  const readable = (agenda: AgendaId) => ops.data?.agendas[agenda];
  return (
    <>
      <PageHeader
        description={t('siampark-ops.agenda.overview.description')}
        title={t('siampark-ops.agenda.overview.title')}
      />
      <AgendaGate onRetry={() => void ops.reload()} readable status={ops.status}>
        <StatRow>
          {agendaIds.map((agenda) => {
            const envelope = readable(agenda);
            return (
              <StatCard
                key={agenda}
                label={t(`siampark-ops.${agenda}.title`)}
                value={envelope === undefined ? '—' : String(countOf(envelope.state))}
              />
            );
          })}
        </StatRow>
      </AgendaGate>
    </>
  );
};

export const OverviewPage = () => (
  <AgendaFrame>
    <UltramodernRouteHead titleKey="siampark-ops.agenda.overview.title" />
    <OverviewView />
  </AgendaFrame>
);

export default OverviewPage;
