import { Match, Schema } from 'effect';
import type { Cause, Effect } from 'effect';

import type { ShellAuthenticationClientOptions } from '../../../api/auth-client.ts';

import type { ChangeDecision, ChangeItemView, ChangePreviewView, ChangeReceiptView } from './changes-model.ts';

export class ChangesClientFailure extends Schema.TaggedError<ChangesClientFailure>()('ChangesClientFailure', {
  cause: Schema.optionalKey(Schema.Defect()),
  reason: Schema.Literals(['unauthenticated', 'forbidden', 'unavailable', 'stalePreview', 'failed']),
}) {}

export interface ChangesListView {
  readonly items: readonly ChangeItemView[];
  readonly nextCursor: string | null;
  readonly writeAvailability?: { readonly available: boolean; readonly reason: string };
}

/** Route integration seam: production uses P1's generated client; tests supply Effects, never fetch. */
export interface ChangesClient {
  readonly decide: (
    preview: ChangePreviewView,
    idempotencyKey: string,
  ) => Effect.Effect<ChangeReceiptView, ChangesClientFailure>;
  readonly list: (
    cursor?: string,
    options?: ShellAuthenticationClientOptions,
  ) => Effect.Effect<ChangesListView, ChangesClientFailure>;
  readonly preview: (
    items: readonly ChangeItemView[],
    decision: ChangeDecision,
  ) => Effect.Effect<ChangePreviewView, ChangesClientFailure>;
}

export const changesFailureNotice = (error: ChangesClientFailure | Cause.TimeoutError) =>
  Match.value(error).pipe(
    Match.tag('ChangesClientFailure', (failure) => failure.reason),
    Match.tag('TimeoutError', () => 'unavailable' as const),
    Match.exhaustive,
  );
