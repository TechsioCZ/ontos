import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import type { OrderDetailState } from './orders-records.ts';

/**
 * Says that reading the open order again failed. The order, its edit form and an unsaved draft stay on screen; the
 * retry reads it again.
 */
export const OrderReloadNotice = ({
  detail,
  onRetry,
}: {
  readonly detail: OrderDetailState;
  readonly onRetry?: (() => void) | undefined;
}) => {
  const { t } = useModernI18n();
  if (detail.status !== 'ready' || detail.reloadFailure === undefined) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-200">
      <StatusText showIcon status="error">
        {t('merchandise.pages.orders.states.reloadFailed')}
      </StatusText>
      {onRetry !== undefined && (
        <Button onClick={onRetry} size="sm" theme="outlined" variant="secondary">
          {t('merchandise.pages.orders.states.retry')}
        </Button>
      )}
    </div>
  );
};
