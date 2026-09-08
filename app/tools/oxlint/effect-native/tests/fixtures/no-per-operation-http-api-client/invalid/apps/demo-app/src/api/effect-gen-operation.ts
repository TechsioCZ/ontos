// expect-count: 3
// Alias imports, namespace imports and `Effect.gen` bodies are all per-operation construction.
import { Effect } from 'effect';
import { HttpApiClient } from 'effect/unstable/httpapi';
import * as bff from '@modern-js/plugin-bff/effect-client';
import { makeEffectHttpApiClient as buildClient } from '@modern-js/plugin-bff/effect-client';
import { contactsApi } from './api.ts';

export const readinessCheck = (baseUrl: string) =>
  Effect.gen(function* () {
    const client = yield* HttpApiClient.make(contactsApi, { baseUrl });
    return yield* client.foundation.readiness({});
  });

export const aliasedOperation = (baseUrl: string) =>
  buildClient(contactsApi, { baseUrl }).pipe(
    Effect.flatMap((client) => client.foundation.readiness({})),
  );

export const namespacedOperation = (baseUrl: string) =>
  bff.makeEffectHttpApiClient(contactsApi, { baseUrl }).pipe(
    Effect.flatMap((client) => client.foundation.readiness({})),
  );
