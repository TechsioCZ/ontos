import type { ConnectionAdminFilter } from '@app/shared-contracts/agent-access';
import { definePageData } from '@app/shared-contracts/page-data';
import { Effect } from 'effect';

import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { loadCompanyConnections } from '../../profile/connected-apps-client.ts';
import type { ConnectionsFailure } from '../../profile/connected-apps-client.ts';

/** A refused or failed connection list read. */
export interface ConnectionsReadFailure {
  readonly detail: string | null;
  readonly reason: ConnectionsFailure;
}

/** The list opens on active connections; history (Odpojené, Nahrazené, …) is one filter away. */
export const DEFAULT_CONNECTIONS_FILTER: ConnectionAdminFilter = { status: 'active' };

/** The company's connections per filter (one per document; a company switch reloads the document). */
export const companyConnectionsData = definePageData({
  key: (filter: ConnectionAdminFilter) =>
    Object.entries(filter)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${name}=${value}`)
      .join('&'),
  load: (filter: ConnectionAdminFilter) =>
    loadCompanyConnections({ filter }).pipe(
      Effect.flatMap((outcome) =>
        outcome.status === 'ok'
          ? Effect.succeed(outcome.value)
          : Effect.fail<ConnectionsReadFailure>({ detail: outcome.detail, reason: outcome.reason }),
      ),
    ),
  runtime: browserRuntime,
});

/** The list the page opens with, prepared before the router reveals it. */
export const preloadConnectionsAdminPage: Effect.Effect<void> = Effect.suspend(() =>
  companyConnectionsData.preload(DEFAULT_CONNECTIONS_FILTER),
);
