import { getEmailProvider, listEmailDeliveries } from '@app/email-delivery/receipt-client';
import type { EmailProviderViewSchema } from '@app/email-delivery/contract';
import { DateTime, Effect, Option, Schedule } from 'effect';
import { financeBrowserRuntime } from '../../../runtime/browser.ts';
// Delivery receipts of payment-reminder e-mails from the demo e-mail dispatcher (same-origin Shell API).
import { formatDateTime } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { useEffect, useState } from 'react';
import { deliveryLabel, emailStatusVariant } from './reminder-email-labels.ts';
import type { EmailDeliveryView } from './reminder-email-labels.ts';

export type ReminderEmailReceipts =
  | { readonly kind: 'loading' }
  | { readonly cause: Effect.Error<ReturnType<typeof listEmailDeliveries>>; readonly kind: 'unavailable' }
  | { readonly byReminderId: ReadonlyMap<string, EmailDeliveryView>; readonly kind: 'ready' };

const loadProvider = getEmailProvider();
export type EmailProviderView = typeof EmailProviderViewSchema.Encoded;
export type EmailProviderState =
  | { readonly kind: 'loading' }
  | { readonly cause: Effect.Error<typeof loadProvider>; readonly kind: 'unavailable' }
  | { readonly kind: 'ready'; readonly provider: EmailProviderView };

/** Sending is offered only when the dispatcher confirms a configured provider. */
export const useEmailProvider = (): EmailProviderState => {
  const [state, setState] = useState<EmailProviderState>({ kind: 'loading' });
  useEffect(() => {
    const load = loadProvider.pipe(
      Effect.match({
        onFailure: (cause): EmailProviderState => ({ cause, kind: 'unavailable' }),
        onSuccess: (provider): EmailProviderState => ({
          kind: 'ready',
          provider: { ...provider, label: Option.getOrNull(provider.label) },
        }),
      }),
      Effect.map(setState),
    );
    const fiber = financeBrowserRuntime.runFork(
      Effect.scoped(Effect.repeat(Effect.forkScoped(load), Schedule.fixed('10 seconds'))),
    );
    return () => {
      fiber.interruptUnsafe();
    };
  }, []);
  return state;
};

export const useReminderEmailReceipts = (reminderIds: readonly string[]): ReminderEmailReceipts => {
  const key = reminderIds.join(',');
  const [state, setState] = useState<{ readonly key: string; readonly receipts: ReminderEmailReceipts }>();
  useEffect(() => {
    const load = listEmailDeliveries({ source: 'rent-reminder', subjectId: key.split(',') }).pipe(
      Effect.match({
        onFailure: (cause): ReminderEmailReceipts => ({ cause, kind: 'unavailable' }),
        onSuccess: ({ deliveries }): ReminderEmailReceipts => ({
          byReminderId: new Map(
            deliveries.map((delivery) => [
              delivery.subjectId,
              {
                ...delivery,
                createdAt: DateTime.formatIso(delivery.createdAt),
                eventAt: DateTime.formatIso(delivery.eventAt),
                eventLabel: Option.getOrNull(delivery.eventLabel),
                sentAt: Option.getOrNull(delivery.sentAt.pipe(Option.map(DateTime.formatIso))),
              },
            ]),
          ),
          kind: 'ready',
        }),
      }),
      Effect.map((receipts) => setState({ key, receipts })),
    );
    // Each tick starts a scoped read; unmounting or changing reminder ids cancels outstanding requests.
    const fiber =
      key === ''
        ? undefined
        : financeBrowserRuntime.runFork(
            Effect.scoped(Effect.repeat(Effect.forkScoped(load), Schedule.fixed('4 seconds'))),
          );
    return () => {
      fiber?.interruptUnsafe();
    };
  }, [key]);
  if (key === '') {
    return { byReminderId: new Map(), kind: 'ready' };
  }
  return state?.key === key ? state.receipts : { kind: 'loading' };
};

export const ReminderEmailStatus = ({
  receipts,
  reminderId,
}: {
  readonly receipts: ReminderEmailReceipts;
  readonly reminderId: string;
}) => {
  if (receipts.kind === 'loading') {
    return <span className="text-fg-secondary text-xs">Zjišťuji stav e-mailu…</span>;
  }
  if (receipts.kind === 'unavailable') {
    return (
      <Badge size="sm" variant="warning">
        Stav e-mailu nedostupný – e-mailová služba neběží
      </Badge>
    );
  }
  const delivery = receipts.byReminderId.get(reminderId);
  if (delivery === undefined) {
    return (
      <Badge size="sm" variant="secondary">
        Čeká na odeslání e-mailem
      </Badge>
    );
  }
  return (
    <Badge size="sm" variant={emailStatusVariant[delivery.status]}>
      {deliveryLabel(delivery, (iso) => formatDateTime(iso))}
    </Badge>
  );
};
