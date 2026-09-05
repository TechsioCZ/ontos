// expect-count: 4
// A9/A1: one client factory rebuilt for every Shell authentication operation.
import { Effect, makeEffectHttpApiClient } from '@modern-js/plugin-bff/effect-client';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';
import { ShellAuthenticationApi } from './api.ts';

interface ShellClientOptions {
  readonly baseUrl?: string;
  readonly cookie?: string;
}

const createShellAuthenticationClient = (options: ShellClientOptions = {}) =>
  makeEffectHttpApiClient(ShellAuthenticationApi, {
    baseUrl: options.baseUrl ?? '/api',
    transformClient: HttpClient.mapRequest(
      HttpClientRequest.setHeader('cookie', options.cookie ?? ''),
    ),
  });

export const signIn = (payload: { readonly email: string }, options: ShellClientOptions = {}) =>
  createShellAuthenticationClient(options).pipe(
    Effect.flatMap((client) => client.authentication.signIn({ payload })),
  );

export const currentSession = (options: ShellClientOptions = {}) =>
  createShellAuthenticationClient(options).pipe(
    Effect.flatMap((client) => client.authentication.currentSession({})),
  );

export const availableTenants = (options: ShellClientOptions = {}) =>
  createShellAuthenticationClient(options).pipe(
    Effect.flatMap((client) => client.tenants.availableTenants({})),
  );
