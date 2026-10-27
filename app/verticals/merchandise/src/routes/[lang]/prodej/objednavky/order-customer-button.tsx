import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { Effect, Schema } from 'effect';
import { useState } from 'react';
import type { Order } from '../../../../../shared/apis/records.ts';
import { OrderCustomerConversionError } from '../../../../../shared/order-customer-conversion.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { convertStaffOrderCustomer } from './order-customer-conversion.ts';

export const OrderCustomerButton = ({
  onConverted,
  order,
  revision,
}: {
  readonly onConverted: () => void;
  readonly order: Order;
  readonly revision: number;
}) => {
  const { t } = useModernI18n();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const convert = () => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    browserRuntime.runFork(
      convertStaffOrderCustomer(order, revision).pipe(
        Effect.match({
          onFailure: (failure) => {
            setBusy(false);
            setError(
              Schema.is(OrderCustomerConversionError)(failure)
                ? failure.reason
                : 'Převod se nepodařilo dokončit. Obnovte data a zkuste to znovu. Již dokončené kroky se neopakují.',
            );
          },
          onSuccess: () => {
            setBusy(false);
            setOpen(false);
            onConverted();
          },
        }),
      ),
    );
  };
  return (
    <>
      <Button onClick={() => setOpen(true)} size="sm" theme="outlined" variant="secondary">
        Převést na zákazníka
      </Button>
      <Dialog
        actions={
          <>
            <Button disabled={busy} onClick={() => setOpen(false)} theme="outlined" variant="secondary">
              Zrušit
            </Button>
            <Button isLoading={busy} loadingText="Převádím…" onClick={convert}>
              Potvrdit převod
            </Button>
          </>
        }
        closeLabel="Zavřít"
        customTrigger
        description={`Kontakt z objednávky ${order.number} bude založen nebo propojen se zákazníkem této firmy. Podobné záznamy nejprve vyžadují posouzení totožnosti. E-mail z objednávky zůstane neověřený.`}
        onOpenChange={({ open: next }) => {
          if (!busy) {
            setOpen(next);
          }
        }}
        open={open}
        title={t('merchandise.ui.convertContactToCustomer')}
      >
        <p>
          {order.contact?.name} · {order.contact?.email}
        </p>
        {error !== null && <StatusText status="error">{error}</StatusText>}
      </Dialog>
    </>
  );
};
