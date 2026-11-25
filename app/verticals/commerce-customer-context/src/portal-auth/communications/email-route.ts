import { Effect, Schema } from 'effect';

import { portalAuthCommunicationRelayAdopted, portalAuthCommunicationRelayAdoption } from './request-relay.ts';

/**
 * WHERE the three Portal Auth e-mails go (#1406 D.1, R-D13). There are exactly two routes and a deployment is on exactly one:
 * - `DIRECT` (the default): the unchanged English direct sender over `EmailDeliveryService`. Nothing is committed to the Auth-local
 *   outbox, the relay loop does not run and a replay of an enrollment re-issues its link, as before Communications existed;
 * - `COMMUNICATIONS`: an issuance commits with its Communication Request into the Auth-local outbox, the relay of the worker host
 *   hands it on and Communications decides it. A replay never re-issues a link on uncertainty (#1282).
 *
 * The route is ONE decision read from the deployment's own configuration, the repository's sanctioned way of selecting between two
 * compositions (`Layer.unwrap` over an optional configuration, as the enrollment owner preparation is selected): the realm is
 * configured AND the relay credential is named. The API composition (`api/index.ts`) that WRITES the outbox and the worker host
 * (`worker-host/entry.ts`) that RELAYS it both ask this one question, so a host can never relay over an outbox nothing writes and a
 * deployment can never write an outbox nothing relays. An unset or blank credential is the default: the direct sender.
 */
export const PortalAuthEmailRouteSchema = Schema.Literals(['COMMUNICATIONS', 'DIRECT']);
export type PortalAuthEmailRoute = typeof PortalAuthEmailRouteSchema.Type;

export const portalAuthEmailRoute: Effect.Effect<PortalAuthEmailRoute> = portalAuthCommunicationRelayAdoption.pipe(
  Effect.map((adoption) => (portalAuthCommunicationRelayAdopted(adoption) ? 'COMMUNICATIONS' : 'DIRECT')),
);
