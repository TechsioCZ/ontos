// Module-level rebindings that are NOT client constructors must stay silent.
import * as bff from '@modern-js/plugin-bff/effect-client';
import { Effect } from 'effect';
import { HttpApiClient } from 'effect/unstable/httpapi';
import { contactsApi } from './api.ts';

/** A local helper aliased at module level: no import binding behind it. */
const localBuild = (api: unknown) => api;
const aliasedLocal = localBuild;

/** A real Effect namespace member that is not a constructor. */
const { Client: ClientType } = HttpApiClient as unknown as { Client: unknown };

/** A namespace member of the BFF module that is not a constructor. */
const { runPromise } = bff as unknown as { runPromise: (effect: unknown) => Promise<unknown> };

const registry = { make: (api: unknown) => api };
const registryMake = registry.make;

export const buildLocal = () => aliasedLocal(contactsApi);
export const buildRegistry = () => registryMake(contactsApi);
export const runIt = () => runPromise(Effect.succeed(ClientType));
