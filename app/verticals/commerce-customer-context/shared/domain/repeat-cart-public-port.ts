import { Context } from 'effect';
import type { Effect } from 'effect';
import type { RepeatOrderCartLineResult } from './history-action-contracts.ts';
import type { HistoryActionUnavailable } from './history-action-unavailable.ts';
import type { RepeatOrderLineResult } from './history-contracts.ts';
import type { CustomerHistorySubject, HistoricalRecordRef } from './record-visibility-contracts.ts';

export type RepeatCartCreationOutcome =
  | {
      readonly cartRef: HistoricalRecordRef;
      readonly lines: readonly RepeatOrderCartLineResult[];
      readonly outcome: 'CREATED';
      readonly repeatPurchaseIntentId: string;
      readonly sourceOrderRef: HistoricalRecordRef;
      readonly subject: CustomerHistorySubject;
    }
  | {
      readonly cartRef: HistoricalRecordRef;
      readonly lines: readonly RepeatOrderCartLineResult[];
      readonly outcome: 'ALREADY_CREATED';
      readonly repeatPurchaseIntentId: string;
      readonly sourceOrderRef: HistoricalRecordRef;
      readonly subject: CustomerHistorySubject;
    }
  | { readonly outcome: 'CONFLICT' };

export interface RepeatCartPublicPort {
  /** Owner-side idempotency is keyed by the originating Action invocation; this never accepts price or terms. */
  readonly createFromHistoricalIntent: (input: {
    readonly actionInvocationId: string;
    /** All source lines, including owner-evaluated changes/skips; Cart returns one outcome per line. */
    readonly lines: readonly RepeatOrderLineResult[];
    /** The originating Action invocation is the stable identity of one deliberate repeat-purchase intent. */
    readonly repeatPurchaseIntentId: string;
    readonly sourceOrderRef: HistoricalRecordRef;
    readonly storefrontId?: string;
    readonly subject: CustomerHistorySubject;
  }) => Effect.Effect<RepeatCartCreationOutcome, HistoryActionUnavailable>;
}

export class RepeatCartOwner extends Context.Service<RepeatCartOwner, RepeatCartPublicPort>()(
  '@app/commerce-customer-context/shared/domain/repeat-cart-public-port/RepeatCartOwner',
) {}
