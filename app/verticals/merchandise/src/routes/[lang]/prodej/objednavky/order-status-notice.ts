import type { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import type { useToast } from '@techsio/ui-kit/molecules/toast';
import { pendingProposalMessage } from '../../../../api/action-result.ts';
import type { OrderStatus } from '../../../../../shared/domain/merchandise-model.ts';
import { statusDoneKey } from './orders-model.ts';

type Translate = ReturnType<typeof useModernI18n>['t'];
type ToastInput = Parameters<ReturnType<typeof useToast>['create']>[0];
type Proposal = Parameters<typeof pendingProposalMessage>[0];

const key = (path: string) => `merchandise.pages.orders.${path}`;

/** Toast for a status change that the Core turned into a proposal awaiting approval. */
export const proposalToast = (proposal: Proposal, t: Translate): ToastInput => ({
  title: pendingProposalMessage(proposal) ?? t(key('bulk.pendingApproval')),
  type: 'info',
});

/** Summary toast after a status change of `total` orders, of which `changed` and `failed` were applied or refused. */
export const statusChangeNotification = (
  t: Translate,
  status: OrderStatus,
  total: number,
  changed: number,
  failed: number,
): ToastInput => {
  if (failed > 0) {
    return {
      description: t(key('bulk.result'), { changed, failed }),
      title: t(key('bulk.partial')),
      type: 'error',
    };
  }
  const doneKey = statusDoneKey(status);
  return {
    title: total === 1 && doneKey !== null ? t(doneKey) : t(key('bulk.success')),
    type: 'success',
  };
};
