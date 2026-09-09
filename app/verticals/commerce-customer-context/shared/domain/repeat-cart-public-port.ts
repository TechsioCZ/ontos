import { Context } from 'effect';
import type { Effect } from 'effect';
import type {
  RepeatCounterpartyOrderPayload,
  RepeatOrderCartLineResult,
  RepeatRetailOrderPayload,
} from './history-action-contracts.ts';
import type { HistoryActionUnavailable } from './history-action-unavailable.ts';
import type { RepeatOrderLineResult } from './history-contracts.ts';
import type { HistoricalRecordRef } from './record-visibility-contracts.ts';

export type RepeatCartCreationOutcome =
  | {
      readonly cartRef: HistoricalRecordRef;
      readonly lines: readonly RepeatOrderCartLineResult[];
      readonly outcome: 'CREATED';
    }
  | {
      readonly cartRef: HistoricalRecordRef;
      readonly lines: readonly RepeatOrderCartLineResult[];
      readonly outcome: 'ALREADY_CREATED';
    }
  | { readonly outcome: 'CONFLICT' };

export interface RepeatCartPublicPort {
  /** Owner-side idempotency is keyed by actionInvocationId; this never accepts price or terms. */
  readonly createFromHistoricalIntent: (input: {
    readonly actionInvocationId: string;
    /** All source lines, including owner-evaluated changes/skips; Cart returns one outcome per line. */
    readonly lines: readonly RepeatOrderLineResult[];
    /** Stable business key: equivalent Repeat requests resolve one Cart across invocations. */
    readonly repeatIntentKey: string;
    readonly sourceOrderRef: HistoricalRecordRef;
    readonly storefrontId?: string;
    readonly subject:
      | RepeatCounterpartyOrderPayload['profileRef']
      | RepeatRetailOrderPayload['profileRef'];
  }) => Effect.Effect<RepeatCartCreationOutcome, HistoryActionUnavailable>;
}

export class RepeatCartOwner extends Context.Service<RepeatCartOwner, RepeatCartPublicPort>()(
  '@app/commerce-customer-context/shared/domain/repeat-cart-public-port/RepeatCartOwner',
) {}
