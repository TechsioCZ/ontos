// expect-count: 3
// EVASION: rebinding the import at module level (plain alias or namespace destructuring) hides
// it from `constructorNames`, and the alias never becomes a "factory" either because no
// constructor CallExpression sits inside a function.
import * as bff from '@modern-js/plugin-bff/effect-client';
import { Effect, makeEffectHttpApiClient } from '@modern-js/plugin-bff/effect-client';
import { contactsApi } from './api.ts';

const buildClient = makeEffectHttpApiClient;
const { makeEffectHttpApiClient: destructuredBuild } = bff;

export const signIn = (email: string) =>
  buildClient(contactsApi, { baseUrl: '/api' }).pipe(
    Effect.flatMap((client) => client.authentication.signIn({ payload: { email } })),
  );

export const currentSession = () =>
  buildClient(contactsApi, { baseUrl: '/api' }).pipe(
    Effect.flatMap((client) => client.authentication.currentSession({})),
  );

export const availableTenants = () =>
  destructuredBuild(contactsApi, { baseUrl: '/api' }).pipe(
    Effect.flatMap((client) => client.tenants.availableTenants({})),
  );
