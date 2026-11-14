// Quick-view panel of one business case on the records list. The body and actions live in pipeline-detail-content.tsx.
import { DocumentTitle, SidePanel } from '@app/admin-ui';
import type { ModulePageContext } from '@app/shared-contracts/page-data';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import type { Opportunity } from '../../../../../shared/model/opportunity.ts';
import { PipelineDetailActions, PipelineDetailBody } from './pipeline-detail-content.tsx';
import type { RecordsLoadError } from './pipeline-records.ts';
import type { PipelineLookups } from './pipeline-table.tsx';

export type OpportunityDetailState =
  | { readonly status: 'closed' }
  | { readonly status: 'pending' }
  | { readonly status: 'denied' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'missing' }
  | { readonly opportunity: Opportunity; readonly status: 'present' };

export type OpportunityDetailNoticeStatus = Exclude<OpportunityDetailState['status'], 'closed' | 'present'>;

export interface OpportunityDetailRead {
  readonly hasResponse: boolean;
  readonly items: readonly Opportunity[];
  readonly loadError?: RecordsLoadError | undefined;
  readonly pending: boolean;
  readonly requestedId?: string | undefined;
}

/**
 * Resolves only the record the authorized read returned under the exact requested id. A completed read that does
 * not contain it is `missing`: never another row from the list, and never a claim about why it is absent.
 */
export const opportunityDetailState = ({
  hasResponse,
  items,
  loadError,
  pending,
  requestedId,
}: OpportunityDetailRead): OpportunityDetailState => {
  if (requestedId === undefined) {
    return { status: 'closed' };
  }
  if (loadError === 'forbidden') {
    return { status: 'denied' };
  }
  if (loadError === 'unavailable') {
    return { status: 'unavailable' };
  }
  if (pending || !hasResponse) {
    return { status: 'pending' };
  }
  const opportunity = items.find((item) => item.id === requestedId);
  return opportunity === undefined ? { status: 'missing' } : { opportunity, status: 'present' };
};

const detailNotices = {
  denied: { message: 'sales-pipeline.pages.records.forbidden', status: 'error' },
  missing: { message: 'sales-pipeline.detail.missing', status: 'warning' },
  pending: { message: 'sales-pipeline.loading', status: 'default' },
  unavailable: { message: 'sales-pipeline.pages.records.unavailable', status: 'error' },
} as const satisfies Readonly<
  Record<OpportunityDetailNoticeStatus, { readonly message: string; readonly status: 'default' | 'error' | 'warning' }>
>;

export const OpportunityDetailNotice = ({ status }: { readonly status: OpportunityDetailNoticeStatus }) => {
  const { t } = useModernI18n();
  const notice = detailNotices[status];
  return status === 'pending' ? (
    <p className="text-fg-secondary text-sm">{t(notice.message)}</p>
  ) : (
    <StatusText showIcon status={notice.status}>
      {t(notice.message)}
    </StatusText>
  );
};

interface PipelineDetailPanelProps {
  readonly canWrite: boolean;
  readonly context?: ModulePageContext | undefined;
  readonly hasResponse: boolean;
  readonly items: readonly Opportunity[];
  readonly loadError: RecordsLoadError | undefined;
  readonly lookups: PipelineLookups;
  readonly onClose: () => void;
  readonly onEdit: (opportunity: Opportunity) => void;
  readonly onStage: (opportunity: Opportunity) => void;
  /** Non-blocking quick view on the list: the list behind stays usable and an outside click keeps the panel open. */
  readonly peek: boolean;
  readonly pending: boolean;
  readonly requestedId: string | undefined;
  readonly revision: number;
}

export const PipelineDetailPanel = ({
  canWrite,
  context,
  hasResponse,
  items,
  loadError,
  lookups,
  onClose,
  onEdit,
  onStage,
  peek,
  pending,
  requestedId,
  revision,
}: PipelineDetailPanelProps) => {
  const { t } = useModernI18n();
  const detail = opportunityDetailState({ hasResponse, items, loadError, pending, requestedId });
  if (detail.status === 'closed') {
    return null;
  }
  if (detail.status !== 'present') {
    return (
      <SidePanel
        actions={
          <div className="flex w-full justify-end">
            <Button className="shrink-0 whitespace-nowrap" onClick={onClose} theme="outlined" variant="secondary">
              {t('sales-pipeline.pages.records.edit.close')}
            </Button>
          </div>
        }
        onOpenChange={(next) => {
          if (!next) {
            onClose();
          }
        }}
        open
        peek={peek}
        resizeLabel={t('sales-pipeline.sidePanel.resize')}
        size="lg"
        title={t('sales-pipeline.detail.title')}
      >
        <div className="flex flex-col gap-250 py-200">
          <OpportunityDetailNotice status={detail.status} />
        </div>
      </SidePanel>
    );
  }
  const { opportunity } = detail;
  const customer = lookups.customerById.get(opportunity.partyId);

  return (
    <SidePanel
      actions={
        <div className="flex w-full flex-wrap justify-end gap-100">
          <PipelineDetailActions
            canWrite={canWrite}
            onClose={onClose}
            onEdit={onEdit}
            onStage={onStage}
            opportunity={opportunity}
          />
        </div>
      }
      description={customer?.name ?? undefined}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      open
      peek={peek}
      resizeLabel={t('sales-pipeline.sidePanel.resize')}
      size="lg"
      title={opportunity.title}
    >
      <DocumentTitle title={opportunity.title} />
      <PipelineDetailBody context={context} lookups={lookups} opportunity={opportunity} revision={revision} />
    </SidePanel>
  );
};
