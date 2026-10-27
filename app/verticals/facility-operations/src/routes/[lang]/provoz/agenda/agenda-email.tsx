// S13 e-mail notifications: provider state and delivery receipts from the Shell-owned public client.
import { getEmailProvider, listEmailDeliveries } from '@app/email-delivery/receipt-client';
import type { EmailDeliveryReceiptSchema, EmailProviderViewSchema } from '@app/email-delivery/receipt-api';
import { DateTime, Effect, Option, Schedule } from 'effect';
import { useEffect, useState } from 'react';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';

export type EmailProviderView = typeof EmailProviderViewSchema.Encoded;
export type EmailProviderState =
  | { readonly kind: 'loading' }
  | { readonly cause: Effect.Error<ReturnType<typeof getEmailProvider>>; readonly kind: 'unavailable' }
  | { readonly kind: 'ready'; readonly provider: EmailProviderView };

type AgendaEmailDelivery = Pick<typeof EmailDeliveryReceiptSchema.Encoded, 'sentAt' | 'status' | 'subjectId'>;
export type AgendaEmailReceipts = ReadonlyMap<string, AgendaEmailDelivery>;

const NO_RECEIPTS: AgendaEmailReceipts = new Map();

/** Is an e-mail provider configured? Unreachable dispatcher means it cannot be confirmed. */
export const useEmailProvider = (): EmailProviderState => {
  const [state, setState] = useState<EmailProviderState>({ kind: 'loading' });
  useEffect(() => {
    const load = getEmailProvider().pipe(
      Effect.match({
        onFailure: (cause): EmailProviderState => ({ cause, kind: 'unavailable' }),
        onSuccess: (provider): EmailProviderState => ({
          kind: 'ready',
          provider: { configured: provider.configured, label: Option.getOrNull(provider.label) },
        }),
      }),
      Effect.map(setState),
    );
    const fiber = browserRuntime.runFork(
      Effect.scoped(Effect.repeat(Effect.forkScoped(load), Schedule.fixed('15 seconds'))),
    );
    return () => {
      fiber.interruptUnsafe();
    };
  }, []);
  return state;
};

/** Receipt key of one delivery batch: the dispatcher sends one e-mail per person and delivery instant. */
export const agendaEmailKey = (principalId: string, createdAtIso: string) => `${principalId}:${createdAtIso}`;

/** Receipts of the signed-in person's own agenda e-mails; failures retain the last available receipts. */
export const useAgendaEmailReceipts = (keys: readonly string[]): AgendaEmailReceipts => {
  const [receiptState, setReceiptState] = useState<{
    readonly cause?: Effect.Error<ReturnType<typeof listEmailDeliveries>>;
    readonly receipts: AgendaEmailReceipts;
  }>({ receipts: NO_RECEIPTS });
  const key = [...new Set(keys)].slice(0, 200).join(',');
  useEffect(() => {
    const load = listEmailDeliveries({ source: 'facility-agenda', subjectId: key.split(',') }).pipe(
      Effect.match({
        onFailure: (cause) => setReceiptState((current) => ({ ...current, cause })),
        onSuccess: ({ deliveries }) => {
          const receipts = new Map(
            deliveries.map(
              (delivery) =>
                [
                  delivery.subjectId,
                  {
                    sentAt: delivery.sentAt.pipe(Option.map(DateTime.formatIso), Option.getOrNull),
                    status: delivery.status,
                    subjectId: delivery.subjectId,
                  },
                ] as const,
            ),
          );
          setReceiptState({ receipts });
        },
      }),
    );
    const program =
      key === ''
        ? Effect.sync(() => setReceiptState({ receipts: NO_RECEIPTS }))
        : Effect.scoped(Effect.repeat(Effect.forkScoped(load), Schedule.fixed('5 seconds'))).pipe(Effect.asVoid);
    const fiber = browserRuntime.runFork(program);
    return () => {
      fiber.interruptUnsafe();
    };
  }, [key]);
  return receiptState.receipts;
};
