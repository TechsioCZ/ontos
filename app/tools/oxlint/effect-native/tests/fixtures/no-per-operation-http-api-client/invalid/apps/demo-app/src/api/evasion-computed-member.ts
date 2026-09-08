// expect-count: 1
// EVASION: a literal-string computed member is statically resolvable but `effectMember` and
// `constructorText` both bail on `computed`.
import { Effect } from 'effect';
import { HttpApiClient } from 'effect/unstable/httpapi';
import { contactsApi } from './api.ts';

export const readiness = (baseUrl: string) =>
  HttpApiClient['make'](contactsApi, { baseUrl }).pipe(
    Effect.flatMap((client) => client.foundation.readiness({})),
  );
