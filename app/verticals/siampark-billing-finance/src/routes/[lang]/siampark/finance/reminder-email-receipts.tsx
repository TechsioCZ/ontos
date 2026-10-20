// @effect-diagnostics *:off
// Delivery receipts of payment-reminder e-mails from the demo e-mail dispatcher (127.0.0.1:3096, CORS for the shell).
import { formatDateTime } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { useEffect, useState } from 'react';
import { deliveryLabel, emailStatusVariant } from './reminder-email-labels.ts';
import type { EmailDeliveryView } from './reminder-email-labels.ts';

export type ReminderEmailReceipts =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable' }
  | { readonly byReminderId: ReadonlyMap<string, EmailDeliveryView>; readonly kind: 'ready' };

const dispatcherBaseUrl = () => `${window.location.protocol}//${window.location.hostname}:3096`;

export const useReminderEmailReceipts = (reminderIds: readonly string[]): ReminderEmailReceipts => {
  const [state, setState] = useState<ReminderEmailReceipts>({ kind: 'loading' });
  const key = reminderIds.join(',');
  useEffect(() => {
    if (key === '') {
      setState({ byReminderId: new Map(), kind: 'ready' });
      return undefined;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const params = new URLSearchParams({ source: 'siampark-reminder' });
        for (const id of key.split(',')) params.append('subjectId', id);
        const response = await fetch(`${dispatcherBaseUrl()}/v1/deliveries?${params.toString()}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as { readonly deliveries: readonly EmailDeliveryView[] };
        if (!cancelled)
          setState({
            byReminderId: new Map(body.deliveries.map((delivery) => [delivery.subjectId, delivery] as const)),
            kind: 'ready',
          });
      } catch {
        if (!cancelled) setState({ kind: 'unavailable' });
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [key]);
  return state;
};

export const ReminderEmailStatus = ({
  receipts,
  reminderId,
}: {
  readonly receipts: ReminderEmailReceipts;
  readonly reminderId: string;
}) => {
  if (receipts.kind === 'loading') return <span className="text-fg-secondary text-xs">Zjišťuji stav e-mailu…</span>;
  if (receipts.kind === 'unavailable')
    return <Badge size="sm" variant="warning">Stav e-mailu nedostupný – e-mailová služba neběží</Badge>;
  const delivery = receipts.byReminderId.get(reminderId);
  if (delivery === undefined) return <Badge size="sm" variant="secondary">Čeká na odeslání e-mailem</Badge>;
  return (
    <Badge size="sm" variant={emailStatusVariant[delivery.status]}>
      {deliveryLabel(delivery, (iso) => formatDateTime(iso))}
    </Badge>
  );
};
