// expect-count: 1
// Pathological extension probe: `.mts` sources are linted and must be covered like `.ts`.
import { Effect, makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import { contactsApi } from './api.ts';

export const signIn = (email: string) =>
  makeEffectHttpApiClient(contactsApi, { baseUrl: '/api' }).pipe(
    Effect.flatMap((client) => client.authentication.signIn({ payload: { email } })),
  );
