import type { LiveChange } from '@app/core-runtime/live/change-notification';
import { Context } from 'effect';
import type { Effect } from 'effect';
import type { HttpServerRequest } from 'effect/http';

import type { LiveScopeUnavailable } from './live-scope-unavailable.ts';

/** Pseudo app id for changes of Shell/Core-owned data (people, agents): the browser revalidates without module reads. */
export const SHELL_APP = 'shell';

/** What one live-changes connection may learn about, resolved from its Shell session when it connects. */
export interface LiveScope {
  /** Module API app ids the session may call (its composition's gateway audiences), plus `SHELL_APP`. */
  readonly allowedApps: ReadonlySet<string>;
  readonly legalEntityId: string;
  /** Installed module id to its deployment app id. */
  readonly moduleApps: ReadonlyMap<string, string>;
  readonly principalId: string;
  readonly tenantId: string;
}

/** The app ids a change invalidates for one scope; empty when the connection must not hear about it at all. */
export const appsForChange = (scope: LiveScope, change: LiveChange): readonly string[] => {
  if (
    change.tenantId !== scope.tenantId ||
    (change.legalEntityId !== null && change.legalEntityId !== scope.legalEntityId)
  ) {
    return [];
  }
  const apps = new Set(change.moduleKeys.map((moduleKey) => scope.moduleApps.get(moduleKey) ?? SHELL_APP));
  return [...apps].filter((app) => scope.allowedApps.has(app)).toSorted();
};

export interface LiveScopeResolverService {
  /** Authenticates the Shell session of the request and derives what its connection may hear about. */
  readonly resolve: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<LiveScope, LiveScopeUnavailable, HttpServerRequest.HttpServerRequest>;
}

/** Provided by the Shell API root, which owns session resolution and the governed composition read. */
export class LiveScopeResolver extends Context.Service<LiveScopeResolver, LiveScopeResolverService>()(
  '@app/shell-super-app/api/live-changes/live-scope/LiveScopeResolver',
) {}
