import { ReadHandlerNotFound, ReadHandlerUnavailable } from '@app/core-runtime';
import { Effect, Match } from 'effect';

import type { LookupResult } from '../services/engagement-profile-persistence.service.ts';

export const readUnavailable =
  (reason: string, configurable = false) =>
  (cause: unknown) =>
    Object.defineProperty(
      new ReadHandlerUnavailable({ code: 'read_handler_unavailable', reason }),
      'cause',
      { configurable, value: cause }
    );

export const requireReadValue =
  (reason: string) =>
  <Value>(found: LookupResult<Value>) =>
    Match.value(found).pipe(
      Match.tag('found', ({ value }) => Effect.succeed(value)),
      Match.tag('not_found', () =>
        Effect.fail(
          new ReadHandlerNotFound({ code: 'read_handler_not_found', reason })
        )
      ),
      Match.exhaustive
    );

export const readDetailResult = <Value>(result: Value) => ({
  evidence: { resultCount: 1 },
  result,
});
