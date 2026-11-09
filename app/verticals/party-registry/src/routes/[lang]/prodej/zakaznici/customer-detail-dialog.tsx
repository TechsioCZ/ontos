import type { RefObject } from 'react';
import { useImperativeHandle } from 'react';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { SidePanel } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { useToast } from '@techsio/ui-kit/molecules/toast';

import type { CustomerListItem } from '../../../../api/customers-client.ts';
import { CUSTOMER_DETAIL_KEY, CustomerDetailContent } from './customer-detail-content.tsx';
import { useCustomerDetail } from './customers-data.ts';
import type { CustomerDetailSnapshot, CustomerLeaveRun } from './customers-data.ts';
import { customerIdentitySummary } from './customers-model.ts';

export interface CustomerDetailDialogProps {
  readonly customer: CustomerListItem | null;
  readonly failure?: 'forbidden' | 'unavailable' | undefined;
  /** Exposes this view's leave check while it is mounted; the ref is cleared when it unmounts. */
  readonly leaveRunRef?: RefObject<CustomerLeaveRun | null> | undefined;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRenamed: () => void;
  readonly onRetry: () => void;
  readonly snapshot?: CustomerDetailSnapshot | undefined;
}

type CustomerDetailViewProps = Omit<CustomerDetailDialogProps, 'customer'> & { readonly customer: CustomerListItem };

const CustomerDetailView = ({
  customer,
  failure,
  leaveRunRef,
  onOpenChange,
  onRenamed,
  onRetry,
  snapshot: initialSnapshot,
}: CustomerDetailViewProps) => {
  const { t } = useModernI18n();
  const toaster = useToast();
  const detail = useCustomerDetail(
    customer,
    initialSnapshot,
    onOpenChange,
    onRenamed,
    () => {
      toaster.create({ title: t(`${CUSTOMER_DETAIL_KEY}.toastRenamed`), type: 'success' });
    },
    t,
  );
  const { name } = customerIdentitySummary(customer, detail.party);
  const handleOpenChange = (open: boolean) => detail.requestClose(open);
  const { requestLeaveThen } = detail;
  useImperativeHandle(leaveRunRef, () => requestLeaveThen, [requestLeaveThen]);

  return (
    <SidePanel
      actions={
        <Button disabled={detail.busy} onClick={() => detail.requestClose(false)} theme="outlined" variant="secondary">
          {t(`${CUSTOMER_DETAIL_KEY}.cancel`)}
        </Button>
      }
      onOpenChange={handleOpenChange}
      open
      peek
      resizeLabel={t('party-registry.sidePanel.resize')}
      size="xl"
      title={name || t(`${CUSTOMER_DETAIL_KEY}.title`)}
    >
      <CustomerDetailContent
        detail={detail}
        failure={failure}
        initialSnapshot={initialSnapshot}
        onRetry={onRetry}
        subject={customer}
      />
    </SidePanel>
  );
};

/** Keyed on the customer only: a refresh that passes through loading keeps the view's unsaved drafts and reason. */
export const CustomerDetailDialog = ({ customer, ...props }: CustomerDetailDialogProps) =>
  customer === null ? null : <CustomerDetailView customer={customer} key={customer.counterpartyId} {...props} />;
