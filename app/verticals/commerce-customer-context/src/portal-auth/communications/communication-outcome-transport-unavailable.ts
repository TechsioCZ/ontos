import { Effect, Layer, Schema } from 'effect';

import { CommercePortalAuthCommunicationOutcomeTransport } from './communication-outcome-transport.ts';

/** The transport of a composition that has no authority to ask the Read: every ask is a typed failure, never an answer. */
class CommunicationOutcomeTransportUnavailable extends Schema.TaggedError<CommunicationOutcomeTransportUnavailable>()(
  'CommunicationOutcomeTransportUnavailable',
  { reason: Schema.Literal('NO_REQUEST_TIME_AUTHORITY') },
) {}

/**
 * The transport of the Auth API process (`api/index.ts`). The Read answers a registered source WORKFLOW about its own requests:
 * Core verifies the calling module on the sealed workload scope of the source's own Outbox Worker delivery
 * (`communications.core.request-source`), and a person, an API key or an admission is refused before anything is read. An
 * enrollment replay runs in a request-time fork of the API process, which holds no such delivery, so it has no authority to
 * ask: until Core and Communications give a request-time source authority (an open owner question), this asks nothing and every
 * ask is the typed unavailable, which makes a replay send and issue nothing new (fail closed). Nothing here answers a guess.
 */
export const communicationOutcomeTransportUnavailableLayer = Layer.succeed(
  CommercePortalAuthCommunicationOutcomeTransport,
  { ask: () => Effect.fail(new CommunicationOutcomeTransportUnavailable({ reason: 'NO_REQUEST_TIME_AUTHORITY' })) },
);
