import {
  Effect,
  makeEffectHttpApiClient,
  runEffectRequest,
} from '@modern-js/plugin-bff/effect-client';
import { shellAuthEffectApi } from './auth-api';
import type { DemoUserKey, SetModuleStatePayload } from './auth-api';

export { runEffectRequest };

export const shellAuthApiContract = {
  apiPrefix: '/shell-super-app-api',
} as const;

export interface ShellAuthClientOptions {
  baseUrl?: string | URL;
}

export const createShellAuthClient = (options: ShellAuthClientOptions = {}) =>
  makeEffectHttpApiClient(shellAuthEffectApi, {
    baseUrl: options.baseUrl ?? shellAuthApiContract.apiPrefix,
  });

export const getShellAuthContext = (options: ShellAuthClientOptions = {}) =>
  createShellAuthClient(options).pipe(Effect.flatMap((client) => client.auth.context({})));

export const signInShellAuth = (demoUserKey: DemoUserKey, options: ShellAuthClientOptions = {}) =>
  createShellAuthClient(options).pipe(
    Effect.flatMap((client) => client.auth.signIn({ payload: { demoUserKey } })),
  );

export const signOutShellAuth = (options: ShellAuthClientOptions = {}) =>
  createShellAuthClient(options).pipe(Effect.flatMap((client) => client.auth.signOut({})));

export const setShellModuleState = (
  payload: SetModuleStatePayload,
  options: ShellAuthClientOptions = {},
) =>
  createShellAuthClient(options).pipe(
    Effect.flatMap((client) => client.auth.setModuleState({ payload })),
  );
