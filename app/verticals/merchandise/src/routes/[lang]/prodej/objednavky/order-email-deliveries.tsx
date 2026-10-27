// E-mails sent to the storefront customer for one order (demo e-mail dispatcher, Shell API).
import { formatDateTime, SectionCard } from '@app/admin-ui';
import { listEmailDeliveries } from '@app/email-delivery/receipt-client';
import { DateTime, Effect, Option, Schedule } from 'effect';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { useEffect, useState } from 'react';
import { deliveryLabel, emailEventLabels, emailStatusVariant } from './order-email-labels.ts';
import type { EmailDeliveryView } from './order-email-labels.ts';

type OrderEmailState =
  | { readonly kind: 'loading' }
  | { readonly cause: Effect.Error<ReturnType<typeof listEmailDeliveries>>; readonly kind: 'unavailable' }
  | { readonly deliveries: readonly EmailDeliveryView[]; readonly kind: 'ready' };

const useOrderEmailDeliveries = (orderId: string): OrderEmailState => {
  const [state, setState] = useState<OrderEmailState>({ kind: 'loading' });
  useEffect(() => {
    const load = listEmailDeliveries({ source: 'akros-order', subjectId: orderId }).pipe(
      Effect.match({
        onFailure: (cause): OrderEmailState => ({ cause, kind: 'unavailable' }),
        onSuccess: ({ deliveries }): OrderEmailState => ({
          deliveries: deliveries.map((delivery) => ({
            ...delivery,
            createdAt: DateTime.formatIso(delivery.createdAt),
            eventAt: DateTime.formatIso(delivery.eventAt),
            eventLabel: Option.getOrNull(delivery.eventLabel),
            sentAt: delivery.sentAt.pipe(Option.map(DateTime.formatIso), Option.getOrNull),
          })),
          kind: 'ready',
        }),
      }),
      Effect.map(setState),
    );
    // Fork each read at the existing four-second cadence; a slow read does not delay the next tick.
    // The enclosing scope interrupts all pending reads when the order changes or this panel unmounts.
    const fiber = browserRuntime.runFork(
      Effect.scoped(Effect.repeat(Effect.forkScoped(load), Schedule.fixed('4 seconds'))),
    );
    return () => {
      fiber.interruptUnsafe();
    };
  }, [orderId]);
  return state;
};

export const OrderEmailDeliveries = ({ orderId }: { readonly orderId: string }) => {
  const state = useOrderEmailDeliveries(orderId);
  return (
    <SectionCard title="E-maily zákazníkovi">
      {state.kind === 'loading' && <p className="text-fg-secondary text-sm">Zjišťuji odeslané e-maily…</p>}
      {state.kind === 'unavailable' && (
        <p className="text-fg-secondary text-sm">Stav e-mailů není dostupný – e-mailová služba neběží.</p>
      )}
      {state.kind === 'ready' && state.deliveries.length === 0 && (
        <p className="text-fg-secondary text-sm">
          K této objednávce zatím nebyl odeslán žádný e-mail. Potvrzení přijetí a změny stavu (Potvrzená, Předáno
          dopravci nebo Připraveno k vyzvednutí, Dokončená, Stornovaná) se zákazníkovi odesílají automaticky; u
          objednávek vytvořených před spuštěním e-mailové služby se e-maily neodesílají.
        </p>
      )}
      {state.kind === 'ready' && state.deliveries.length > 0 && (
        <ul className="flex flex-col divide-y divide-border-primary text-sm">
          {state.deliveries.map((delivery) => (
            <li className="flex flex-wrap items-center gap-150 py-100" key={delivery.event}>
              <span className="font-medium">{delivery.eventLabel ?? emailEventLabels[delivery.event]}</span>
              <Badge size="sm" variant={emailStatusVariant[delivery.status]}>
                {deliveryLabel(delivery, (iso) => formatDateTime(iso))}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
};
