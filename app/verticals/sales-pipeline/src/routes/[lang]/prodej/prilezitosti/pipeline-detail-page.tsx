// Full page of one business case. The records route shows it in place of the list while `?opportunityId=` names a
// case and the person chose the full page. Body and actions are shared with the side panel.
import { DocumentTitle, PageHeader } from '@app/admin-ui';
import type { ModulePageContext } from '@app/shared-contracts/page-data';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import type { Opportunity } from '../../../../../shared/model/opportunity.ts';
import { PipelineDetailActions, PipelineDetailBody } from './pipeline-detail-content.tsx';
import { OpportunityDetailNotice, opportunityDetailState } from './pipeline-detail-panel.tsx';
import type { RecordsLoadError } from './pipeline-records.ts';
import type { PipelineLookups } from './pipeline-table.tsx';

interface PipelineDetailPageProps {
  readonly canWrite: boolean;
  readonly context?: ModulePageContext | undefined;
  readonly hasResponse: boolean;
  readonly items: readonly Opportunity[];
  readonly loadError: RecordsLoadError | undefined;
  readonly lookups: PipelineLookups;
  readonly onBack: () => void;
  readonly onEdit: (opportunity: Opportunity) => void;
  readonly onStage: (opportunity: Opportunity) => void;
  readonly pending: boolean;
  readonly requestedId: string;
  readonly revision: number;
}

export const PipelineDetailPage = ({
  canWrite,
  context,
  hasResponse,
  items,
  loadError,
  lookups,
  onBack,
  onEdit,
  onStage,
  pending,
  requestedId,
  revision,
}: PipelineDetailPageProps) => {
  const { t } = useModernI18n();
  const detail = opportunityDetailState({ hasResponse, items, loadError, pending, requestedId });
  const opportunity = detail.status === 'present' ? detail.opportunity : undefined;
  const customer = opportunity === undefined ? undefined : lookups.customerById.get(opportunity.partyId);

  return (
    <section className="flex flex-col gap-200">
      <DocumentTitle title={opportunity?.title} />
      <PageHeader
        actions={
          opportunity === undefined ? undefined : (
            <div className="flex flex-wrap items-center gap-100">
              <PipelineDetailActions canWrite={canWrite} onEdit={onEdit} onStage={onStage} opportunity={opportunity} />
            </div>
          )
        }
        breadcrumbs={
          <div>
            <Button icon="icon-[mdi--arrow-left]" onClick={onBack} size="sm" theme="outlined" variant="secondary">
              {t('sales-pipeline.detail.backToList')}
            </Button>
          </div>
        }
        description={customer?.name ?? undefined}
        title={opportunity?.title ?? t('sales-pipeline.detail.title')}
      />
      {opportunity === undefined ? (
        detail.status !== 'closed' && detail.status !== 'present' && <OpportunityDetailNotice status={detail.status} />
      ) : (
        <PipelineDetailBody context={context} lookups={lookups} opportunity={opportunity} revision={revision} />
      )}
    </section>
  );
};
