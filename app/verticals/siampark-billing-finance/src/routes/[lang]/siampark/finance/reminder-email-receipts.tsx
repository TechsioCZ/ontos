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

/** GET /v1/provider of the dispatcher (copied from app/scripts/demo/email-dispatcher/contract.ts EmailProviderView). */
export interface EmailProviderView {
  readonly configured: boolean;
  readonly label: string | null;
}
export type EmailProviderState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'ready'; readonly provider: EmailProviderView };

/** S07-R8: sending is offered only when an e-mail provider is configured; an unreachable dispatcher cannot confirm it. */
export const useEmailProvider = (): EmailProviderState => {
  const [state, setState] = useState<EmailProviderState>({ kind: 'loading' });
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`${dispatcherBaseUrl()}/v1/provider`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const provider = (await response.json()) as EmailProviderView;
        if (!cancelled) setState({ kind: 'ready', provider });
      } catch {
        if (!cancelled) setState({ kind: 'unavailable' });
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
  return state;
};

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
        // The dispatcher verifies the OntOS session cookie and returns only this company's receipts.
        const response = await fetch(`${dispatcherBaseUrl()}/v1/deliveries?${params.toString()}`, {
          cache: 'no-store',
          credentials: 'include',
        });
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
    return (
      <Badge size="sm" variant="warning">
        Stav e-mailu nedostupný – e-mailová služba neběží
      </Badge>
    );
  const delivery = receipts.byReminderId.get(reminderId);
  if (delivery === undefined)
    return (
      <Badge size="sm" variant="secondary">
        Čeká na odeslání e-mailem
      </Badge>
    );
  return (
    <Badge size="sm" variant={emailStatusVariant[delivery.status]}>
      {deliveryLabel(delivery, (iso) => formatDateTime(iso))}
    </Badge>
  );
};
