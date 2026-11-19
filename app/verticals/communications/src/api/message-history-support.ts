import type { ReadHandlerContext } from '@app/core-runtime';
import type { Effect } from 'effect';

import type { messageHistoryReadService } from '../services/message-history-read.service.ts';

/** The typed owner services of both history Reads. */
export type MessageHistoryReadServices = Effect.Success<ReturnType<typeof messageHistoryReadService>>;

/**
 * Whether the caller may read one governed field. A path is readable only when the gate decided the Read AND did not deny
 * the group: an absent answer is never a grant, so a Read the gate did not decide shows no personal-data field.
 */
export const mayReadField = (context: Pick<ReadHandlerContext<unknown>, 'deniedFieldPaths'>, path: string) =>
  context.deniedFieldPaths !== undefined && !context.deniedFieldPaths.some((denied) => denied.join('.') === path);
