import { Effect, Layer } from 'effect';

import { CommercePortalAuthDatabase } from '../persistence/portal-auth-database.ts';
import { CommercePortalAuthAudit, makeCommercePortalAuthAuditRecorder } from './audit.ts';

/**
 * The single Layer the composition root wires for Commerce portal authentication audit evidence.
 *
 * It lives beside `audit.ts` rather than in it because this is the only part of the audit module that needs the
 * portal's own database pool. An Action that merely records an audit row imports the tag and the recorder from
 * `audit.ts`, which stays a leaf; only a composition root that actually wires the pool imports this file. That keeps
 * the portal's `PgClient` pool out of the Outbox worker's bundle, whose `@app/core-runtime` is the narrow worker
 * surface and carries no database-pool constructors.
 */
export const CommercePortalAuthAuditLive = Layer.effect(
  CommercePortalAuthAudit,
  CommercePortalAuthDatabase.pipe(Effect.map((database) => makeCommercePortalAuthAuditRecorder(database.executor))),
);
