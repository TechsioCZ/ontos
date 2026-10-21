// @effect-diagnostics *:off
// S13 e-mail notifications: provider state and delivery receipts from the demo e-mail dispatcher (127.0.0.1:3096).
// Types copied from app/scripts/demo/email-dispatcher/contract.ts (no cross-package import).
import { useEffect, useState } from 'react';

export interface EmailProviderView {
  readonly configured: boolean;
  readonly label: string | null;
}
export type EmailProviderState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'ready'; readonly provider: EmailProviderView };

interface AgendaEmailDelivery {
  readonly sentAt: string | null;
  readonly status: 'SENDING' | 'SENT' | 'RETRY' | 'FAILED' | 'UNKNOWN';
  readonly subjectId: string;
}
export type AgendaEmailReceipts = ReadonlyMap<string, AgendaEmailDelivery>;

const dispatcherBaseUrl = () => `${window.location.protocol}//${window.location.hostname}:3096`;

/** Is an e-mail provider configured (dispatcher GET /v1/provider)? Unreachable dispatcher = cannot be confirmed. */
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
    const timer = window.setInterval(() => void load(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
  return state;
};

/** Receipt key of one delivery batch: the dispatcher sends one e-mail per person and delivery instant. */
export const agendaEmailKey = (principalId: string, createdAtIso: string) => `${principalId}:${createdAtIso}`;

/** Receipts of the signed-in person's own agenda e-mails (the dispatcher refuses keys of other people). */
export const useAgendaEmailReceipts = (keys: readonly string[]): AgendaEmailReceipts => {
  const [receipts, setReceipts] = useState<AgendaEmailReceipts>(new Map());
  const key = [...new Set(keys)].slice(0, 200).join(',');
  useEffect(() => {
    if (key === '') {
      setReceipts(new Map());
      return undefined;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const params = new URLSearchParams({ source: 'siampark-agenda' });
        for (const id of key.split(',')) params.append('subjectId', id);
        const response = await fetch(`${dispatcherBaseUrl()}/v1/deliveries?${params.toString()}`, {
          cache: 'no-store',
          credentials: 'include',
        });
        if (!response.ok) return;
        const body = (await response.json()) as { readonly deliveries: readonly AgendaEmailDelivery[] };
        if (!cancelled) setReceipts(new Map(body.deliveries.map((delivery) => [delivery.subjectId, delivery] as const)));
      } catch {
        // No receipts shown while the dispatcher is unreachable; the in-app notification itself is unaffected.
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [key]);
  return receipts;
};
