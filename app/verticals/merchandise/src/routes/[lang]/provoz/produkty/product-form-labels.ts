import { pendingProposalMessage } from '../../../../api/action-result.ts';
import type { ActionProposalAccepted } from '@app/core-runtime/http/action-proposal';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import type { FailureReason } from './products-api.ts';

const KEY_PREFIX = 'merchandise.pages.products';

/** Translates a key under the products namespace. */
export const useProductLabel = () => {
  const { t } = useModernI18n();
  return (path: string, values?: Record<string, number | string>) => t(`${KEY_PREFIX}.${path}`, values);
};
export type ProductLabel = ReturnType<typeof useProductLabel>;

/** Failure text for a refused command. Conflicts also ask the page to reload. */
export const useCommandFailure = () => {
  const label = useProductLabel();
  return (reason: FailureReason, onReload: () => void, proposal?: ActionProposalAccepted): string => {
    if (proposal !== undefined) {
      return pendingProposalMessage(proposal) ?? label('messages.failed');
    }
    if (reason === 'conflict') {
      onReload();
      return label('messages.conflict');
    }
    if (reason === 'category-slug-taken') {
      return label('messages.categorySlugTaken');
    }
    if (reason === 'variant-sku-required') {
      return label('messages.variantSkuRequired');
    }
    if (reason === 'variant-bulk-price-unsupported') {
      return label('messages.variantBulkPriceUnsupported');
    }
    if (reason === 'stock-reconciliation-required') {
      return label('messages.stockReconciliationRequired');
    }
    if (reason === 'rejected') {
      return label('messages.rejected');
    }
    return label('messages.failed');
  };
};
