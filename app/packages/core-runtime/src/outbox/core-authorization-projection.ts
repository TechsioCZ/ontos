import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Effect, Schema } from 'effect';
import { Hex } from 'effect/encoding';

import { AccessProjectionWriter } from '../access/intent/projection-writer.ts';
import { TrustedPrincipalContextSchema } from '../actions/principal-context.ts';
import type { OperationalScope } from '../operations/context.ts';

/**
 * A Core-owned background reconcile that could not be prepared. It is a retryable worker failure, never a
 * silent success: an unattested claim, a missing acting principal or an unreadable tenant scope refuses.
 */
export class CoreAuthorizationProjectionError extends Schema.TaggedError<CoreAuthorizationProjectionError>()(
  'CoreAuthorizationProjectionError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    reason: Schema.String,
  },
) {}

const refused = (reason: string, cause?: unknown): CoreAuthorizationProjectionError =>
  cause === undefined
    ? new CoreAuthorizationProjectionError({ reason })
    : new CoreAuthorizationProjectionError({ cause, reason });

/**
 * The tenant-wide projection scope of one attested Outbox claim (O66). Under authorization v2 the graph
 * is the projection of PostgreSQL intent, so every Core lifecycle wake-up reconciles the whole tenant
 * under its own tenant-context fence; the wake-up names which intent moved, never which tuple to write.
 *
 * The scope is Core's own background identity: a `system` context bound to the attested claim and to the
 * acting principal the claim recorded. It carries no legal entity, because a tenant is projected whole
 * (D13), and no session provenance is fabricated from the message body.
 */
export const outboxWorkerTenantScope = (input: {
  readonly actorPrincipalId?: string;
  readonly claimId: string;
  readonly tenantId: string;
}): Effect.Effect<OperationalScope, CoreAuthorizationProjectionError> => {
  const { actorPrincipalId, claimId, tenantId } = input;
  if (actorPrincipalId === undefined) {
    return Effect.fail(refused('A Core projection wake-up needs the attested acting principal its claim recorded'));
  }
  if (claimId.length === 0) {
    return Effect.fail(refused('The Core projection wake-up scope is invalid'));
  }
  // Native claim ids include owner delimiters and may exceed the safe run-reference length.
  // Hash the entire id, including its owner, without changing the claim or its correlation evidence.
  const runReference = Hex.encode(sha256(utf8ToBytes(claimId)));
  return Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
    authContextRef: `job:core.authorization.outbox:run:${runReference}`,
    authMethod: 'system',
    principalId: actorPrincipalId,
    tenantId,
  }).pipe(
    Effect.map((scope) => ({ ...scope, correlationId: `core.authorization.outbox:${claimId}` })),
    Effect.mapError((cause) => refused('The Core projection wake-up scope is invalid', cause)),
  );
};

/**
 * One tenant reconcile for an attested Core lifecycle wake-up. The writer is the single Core writer: it
 * takes the tenant's scope fence, reads one complete tenant intent, projects the minimal difference and
 * verifies the graph equals intent, so a wake-up that arrives twice is observably a no-op.
 */
export const reconcileTenantProjection = Effect.fn('CoreAuthorizationProjection.reconcileTenantProjection')(
  function* reconcileTenantProjection(input: {
    readonly actorPrincipalId?: string;
    readonly claimId: string;
    readonly tenantId: string;
  }) {
    const scope = yield* outboxWorkerTenantScope(input);
    const writer = yield* AccessProjectionWriter;
    return yield* writer.reconcileTenant({ scope });
  },
);

/**
 * What a Core background process composes to reconcile a tenant, in the root's own order. Core keeps this
 * a description, never a `Layer.provide` (a library layer stays dependency transparent, so the
 * application root closes the graph — `effect-native/no-layer-provide-in-library`):
 *
 * ```ts
 * const projectionLive = AccessProjectionWriterLive.pipe(
 *   Layer.provide(
 *     Layer.mergeAll(
 *       CoreAuthorizationProjectionCompilerLive,
 *       AccessWriteJournalStoreLive,
 *       TenantIntentLoaderLive,
 *       NodeCrypto.layer,
 *     ),
 *   ),
 * );
 * ```
 *
 * The root then provides `CorePersistenceLive`/`DatabaseConfigLive` (for `CoreDatabase`) and
 * `SpiceDbConfigLive`, and registers `ActionAuthorizationLifecycleLive` provided with
 * `projectionLive` beside the workers' own dependencies.
 */
export { CoreAuthorizationProjectionCompilerLive } from '../access/compiler/spice-db-compiler.ts';
export { AccessProjectionWriter, AccessProjectionWriterLive } from '../access/intent/projection-writer.ts';
export { AccessWriteJournalStoreLive } from '../access/lifecycle/persistence/journal-store.ts';
export { SpiceDbConfigLive } from '../permissions/config.ts';
export { TenantIntentLoaderLive } from '../access/intent/tenant-intent-loader.ts';
