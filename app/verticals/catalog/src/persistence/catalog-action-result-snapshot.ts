import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { isDeepStrictEqual } from 'node:util';
import { and, eq } from 'drizzle-orm';
import { Effect, Schema } from 'effect';

import { catalogResultSnapshots } from '../database/schema.ts';
import { CatalogPersistenceConflict, CatalogPersistenceUnavailable } from './errors.ts';

/* oxlint-disable anti-slop/no-object-parameters, anti-slop/no-runtime-typeof -- The declared typed codec owns this JSONB I/O boundary; only JSON objects pass through and are revalidated before decode. owner: Catalog #478; remove when a shared recursive JSON-value schema exists. expires: 2027-03-31. */

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
/** The caller's declared result schema supplies both directions; raw JSON never leaves this port. */
export interface CatalogActionResultCodec<Result> {
  readonly decode: (encoded: object) => Effect.Effect<Result, Error>;
  readonly encode: (result: Result) => Effect.Effect<object, Error>;
}

export interface CatalogActionResultIdentity {
  readonly actionInvocationId: string;
  readonly actionKey: string;
  readonly schemaVersion: number;
}

const unavailable = (cause?: unknown): CatalogPersistenceUnavailable => {
  const failure = new CatalogPersistenceUnavailable({
    code: 'catalog_persistence_unavailable',
    reason: 'Catalog Action result snapshot is unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const divergentReplay = (): CatalogPersistenceConflict =>
  new CatalogPersistenceConflict({
    code: 'catalog_persistence_conflict',
    conflict: 'ACTION_INVOCATION_ID',
    reason: 'Action invocation already has a different result snapshot',
  });

export const validCatalogActionResultIdentity = ({
  actionInvocationId,
  actionKey,
  schemaVersion,
}: CatalogActionResultIdentity): boolean =>
  /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/iu.test(actionInvocationId) &&
  actionKey.length > 0 &&
  actionKey.length <= 200 &&
  actionKey === actionKey.trim() &&
  Number.isSafeInteger(schemaVersion) &&
  schemaVersion > 0;

const normalizedJson = Effect.fn('CatalogActionResultSnapshot.normalizedJson')(function* normalize(encoded: object) {
  const text = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(encoded).pipe(
    Effect.mapError(unavailable),
  );
  const size = Buffer.byteLength(text, 'utf-8');
  if (size < 2 || size > 65_536) {
    return yield* unavailable();
  }
  const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
    Effect.mapError(unavailable),
  );
  if (decoded === null || typeof decoded !== 'object') {
    return yield* unavailable();
  }
  return decoded;
});

/** Core supplies the scoped transaction; its succeeded commit marker is checked outside this owner service. */
export const catalogActionResultSnapshotForScope = <Result>(
  transaction: ScopedTransaction,
  scope: OperationalScope,
  codec: CatalogActionResultCodec<Result>,
) => {
  const readRow = (actionInvocationId: string) =>
    transaction
      .select()
      .from(catalogResultSnapshots)
      .where(
        and(
          eq(catalogResultSnapshots.tenantId, scope.tenantId),
          eq(catalogResultSnapshots.actionInvocationId, actionInvocationId),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));

  const matchesIdentity = (row: typeof catalogResultSnapshots.$inferSelect, identity: CatalogActionResultIdentity) =>
    row.tenantId === scope.tenantId &&
    row.actingPrincipalId === scope.principalId &&
    row.actionInvocationId === identity.actionInvocationId &&
    row.actionKey === identity.actionKey &&
    row.schemaVersion === identity.schemaVersion;

  const read = Effect.fn('CatalogActionResultSnapshot.read')(function* read(identity: CatalogActionResultIdentity) {
    if (!validCatalogActionResultIdentity(identity)) {
      return yield* unavailable();
    }
    const [row] = yield* readRow(identity.actionInvocationId);
    if (row === undefined || !matchesIdentity(row, identity)) {
      return yield* unavailable();
    }
    if (row.encodedResult === null || typeof row.encodedResult !== 'object') {
      return yield* unavailable();
    }
    return yield* codec.decode(row.encodedResult).pipe(Effect.mapError(unavailable));
  });

  const insert = Effect.fn('CatalogActionResultSnapshot.insert')(function* insert(
    identity: CatalogActionResultIdentity,
    result: Result,
  ) {
    if (!validCatalogActionResultIdentity(identity)) {
      return yield* unavailable();
    }
    const encoded = yield* codec.encode(result).pipe(Effect.mapError(unavailable));
    const normalized = yield* normalizedJson(encoded);
    const [created] = yield* transaction
      .insert(catalogResultSnapshots)
      .values({
        actingPrincipalId: scope.principalId,
        actionInvocationId: identity.actionInvocationId,
        actionKey: identity.actionKey,
        encodedResult: normalized,
        schemaVersion: identity.schemaVersion,
        tenantId: scope.tenantId,
      })
      .onConflictDoNothing()
      .returning()
      .pipe(Effect.mapError(unavailable));
    if (created !== undefined) {
      return result;
    }
    const [existing] = yield* readRow(identity.actionInvocationId);
    if (existing === undefined) {
      return yield* unavailable();
    }
    if (!matchesIdentity(existing, identity) || !isDeepStrictEqual(existing.encodedResult, normalized)) {
      return yield* divergentReplay();
    }
    if (existing.encodedResult === null || typeof existing.encodedResult !== 'object') {
      return yield* unavailable();
    }
    return yield* codec.decode(existing.encodedResult).pipe(Effect.mapError(unavailable));
  });

  return Object.freeze({ insert, read });
};

/** Call from an Action's decoded-success hook while Core's business transaction is still open. */
export const captureCatalogActionResult = <Result>(
  transaction: ScopedTransaction,
  scope: OperationalScope,
  identity: CatalogActionResultIdentity,
  codec: CatalogActionResultCodec<Result>,
  result: Result,
) => catalogActionResultSnapshotForScope(transaction, scope, codec).insert(identity, result).pipe(Effect.asVoid);
