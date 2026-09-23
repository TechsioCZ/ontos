import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { ActionRuntime } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { Effect } from 'effect';

import { catalogResultSnapshots } from '../database/schema.ts';
import type {
  CatalogActionResultCodec,
  CatalogActionResultIdentity,
} from '../persistence/catalog-action-result-snapshot.ts';
import {
  catalogActionResultSnapshotForScope,
  validCatalogActionResultIdentity,
} from '../persistence/catalog-action-result-snapshot.ts';
// oxlint-disable sonarjs/function-name -- Effect.catchTags requires declared error tag keys. owner: Catalog #478; expires: 2027-03-31.

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

export type CatalogActionRecovery<Result> =
  | { readonly result: Result; readonly status: 'committed' }
  | { readonly status: 'open' }
  | { readonly status: 'rejected' }
  | { readonly status: 'absent' }
  | { readonly status: 'indeterminate' }
  | { readonly status: 'unavailable' };

/**
 * Recover the current snapshot version first, then older compatible result encodings. An
 * unavailable current lookup can mean that the committed row belongs to an older Action schema;
 * every other status is authoritative and stops the search.
 */
export const recoverCatalogActionResultVersions = Effect.fn('CatalogActionResultRecovery.recoverVersions')(<
  Result,
  Failure,
  Requirements,
>(
  schemaVersions: readonly [number, ...number[]],
  recover: (schemaVersion: number) => Effect.Effect<CatalogActionRecovery<Result>, Failure, Requirements>,
): Effect.Effect<CatalogActionRecovery<Result>, Failure, Requirements> => {
  const initial: CatalogActionRecovery<Result> = { status: 'unavailable' };
  return Effect.reduce(
    schemaVersions,
    (): CatalogActionRecovery<Result> => initial,
    (outcome, schemaVersion) => (outcome.status === 'unavailable' ? recover(schemaVersion) : Effect.succeed(outcome)),
  );
});

/** The caller supplies trusted scope and an owner-scoped transaction; neither comes from request payload. */
export const recoverCatalogActionResult = Effect.fn('CatalogActionResultRecovery.recover')(function* recover<Result>(
  transaction: ScopedTransaction,
  scope: OperationalScope,
  identity: CatalogActionResultIdentity,
  codec: CatalogActionResultCodec<Result>,
) {
  if (!validCatalogActionResultIdentity(identity)) {
    return { status: 'absent' } as const;
  }
  const runtime = yield* ActionRuntime;
  const resolution = yield* runtime
    .resolveActionCommit({ invocationId: identity.actionInvocationId, principal: scope })
    .pipe(
      Effect.map(() => 'open' as const),
      Effect.catchTags({
        ActionAlreadyCommitted: () => Effect.succeed('committed' as const),
        ActionCommitIndeterminate: () => Effect.succeed('indeterminate' as const),
        ActionInvocationNotFound: () => Effect.succeed('absent' as const),
        ActionInvocationStateError: () => Effect.succeed('rejected' as const),
        ActionPayloadValidationError: () => Effect.succeed('absent' as const),
        ActionTrustedContextValidationError: () => Effect.succeed('indeterminate' as const),
      }),
    );
  if (resolution === 'open') {
    return { status: 'open' } as const;
  }
  if (resolution === 'rejected') {
    return { status: 'rejected' } as const;
  }
  if (resolution === 'absent') {
    return { status: 'absent' } as const;
  }
  if (resolution === 'indeterminate') {
    return { status: 'indeterminate' } as const;
  }

  // Core's succeeded marker is authoritative. A missing/corrupt owner snapshot
  // after this point must never be interpreted as an uncommitted Action.
  const row = yield* transaction
    .select()
    .from(catalogResultSnapshots)
    .where(
      and(
        eq(catalogResultSnapshots.tenantId, scope.tenantId),
        eq(catalogResultSnapshots.actionInvocationId, identity.actionInvocationId),
      ),
    )
    .limit(1)
    .pipe(
      Effect.map((rows) => rows[0]),
      Effect.orElseSucceed(() => null),
    );
  if (row === null || row === undefined) {
    return { status: 'unavailable' } as const;
  }
  if (row.actingPrincipalId !== scope.principalId || row.actionKey !== identity.actionKey) {
    return { status: 'absent' } as const;
  }
  if (row.schemaVersion !== identity.schemaVersion) {
    return { status: 'unavailable' } as const;
  }

  const result = yield* catalogActionResultSnapshotForScope(transaction, scope, codec)
    .read(identity)
    .pipe(
      Effect.map((value) => ({ result: value, status: 'committed' }) as const),
      Effect.orElseSucceed(() => ({ status: 'unavailable' }) as const),
    );
  return result;
});
