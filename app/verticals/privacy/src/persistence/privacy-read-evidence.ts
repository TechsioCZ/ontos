import type { DataAccessEventInput } from '@app/core-runtime';
import { Effect } from 'effect';

/** Invocation-local metadata only. Repositories append the actual result count after their SQL read. */
export const capturePrivacyRead = (
  evidence: DataAccessEventInput[] | undefined,
  observation: Pick<DataAccessEventInput, 'accessKind' | 'queryHash' | 'resultCount'>,
): Effect.Effect<void> =>
  Effect.sync(() => {
    evidence?.push({ ...observation, servingModuleKey: 'privacy.core' });
  });
