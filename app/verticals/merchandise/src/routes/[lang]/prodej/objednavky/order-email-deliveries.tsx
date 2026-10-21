// @effect-diagnostics *:off
// E-mails sent to the storefront customer for one order (demo e-mail dispatcher, 127.0.0.1:3096).
import { formatDateTime, SectionCard } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { useEffect, useState } from 'react';
import { deliveryLabel, emailEventLabels, emailStatusVariant } from './order-email-labels.ts';
import type { EmailDeliveryView } from './order-email-labels.ts';

type OrderEmailState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable' }
  | { readonly deliveries: readonly EmailDeliveryView[]; readonly kind: 'ready' };

const dispatcherBaseUrl = () => `${window.location.protocol}//${window.location.hostname}:3096`;

const useOrderEmailDeliveries = (orderId: string): OrderEmailState => {
  const [state, setState] = useState<OrderEmailState>({ kind: 'loading' });
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const params = new URLSearchParams({ source: 'akros-order', subjectId: orderId });
        // The dispatcher verifies the OntOS session cookie and returns only this company's receipts.
        const response = await fetch(`${dispatcherBaseUrl()}/v1/deliveries?${params.toString()}`, {
          cache: 'no-store',
          credentials: 'include',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as { readonly deliveries: readonly EmailDeliveryView[] };
        if (!cancelled) setState({ deliveries: body.deliveries, kind: 'ready' });
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
