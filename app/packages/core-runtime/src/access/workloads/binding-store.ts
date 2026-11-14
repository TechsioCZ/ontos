import { and, eq } from 'drizzle-orm';
import { Effect, Layer } from 'effect';

import { CoreDatabase } from '../../db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../../db/database-identities.ts';
import { accessWorkloadBindings } from '../../db/schema.ts';
import type { CoreTransaction } from '../../db/types.ts';
import type { OperationalScope } from '../../operations/context.ts';
import { intentConflict } from '../intent/errors.ts';
import type { AccessIntentError } from '../intent/errors.ts';
import type { AccessIntentDatabase } from '../intent/persistence.ts';
import { durable, runScoped, scopeIssue } from '../intent/persistence.ts';
import { AccessWorkloadBindingStore } from './store.ts';
import { lockWorkloadAuthority } from './authority-fence.ts';
import type {
  AccessWorkloadBindingStoreService,
  RegisterWorkloadBindingInput,
  RegisterWorkloadBindingsInput,
  RevokeWorkloadBindingInput,
} from './store.ts';

/** The unique indexes of `access_workload_bindings`; a collision is the same conflict as a lost compare-and-set. */
const OWNER_UNIQUE_CONSTRAINTS: ReadonlySet<string> = new Set([
  'access_workload_bindings_active_uk',
  'access_workload_bindings_incarnation_uk',
  'access_workload_bindings_pkey',
  'access_workload_bindings_tenant_id_uk',
]);

const commandIssue = (scope: OperationalScope, bindings: readonly RegisterWorkloadBindingInput[]): string | null => {
  for (const binding of bindings) {
    const issue = scopeIssue(scope, [binding.tenantId]);
    if (issue !== null) {
      return issue;
    }
  }
  return null;
};

const insertValues = (binding: RegisterWorkloadBindingInput) => ({
  bindingId: binding.bindingId,
  createdAt: binding.createdAt,
  incarnation: binding.incarnation,
  principalId: binding.principalId,
  revokedAt: null,
  status: 'active' as const,
  tenantId: binding.tenantId,
  workloadKey: binding.workloadKey,
});

const writeBindingRows = (
  transaction: CoreTransaction,
  bindings: readonly RegisterWorkloadBindingInput[],
): Effect.Effect<void, AccessIntentError> =>
  bindings.length === 0
    ? Effect.void
    : transaction
        .insert(accessWorkloadBindings)
        .values(bindings.map(insertValues))
        // A bootstrap is idempotent: a binding that already exists (active or revoked) stays as it is,
        // so a re-run never revives what an administrator ended (D27).
        .onConflictDoNothing()
        .pipe(durable(OWNER_UNIQUE_CONSTRAINTS), Effect.asVoid);

/**
 * Registers active bindings in the caller's own scope, refusing a command that names another tenant.
 * A bootstrap writer (the stage and local installers) calls this directly with the Core executor it
 * already holds, exactly as it writes the scopes and the owner's assignment; the service below is the
 * same write through the bound `AccessWorkloadBindingStore` for callers that resolve it from context.
 */
export const writeWorkloadBindings = (
  database: AccessIntentDatabase,
  scope: OperationalScope,
  input: RegisterWorkloadBindingsInput,
): Effect.Effect<void, AccessIntentError> => {
  const issue = commandIssue(scope, input.bindings);
  return issue === null
    ? runScoped(database, scope, OWNER_UNIQUE_CONSTRAINTS, (transaction) =>
        writeBindingRows(transaction, input.bindings),
      )
    : Effect.fail(intentConflict('access_intent_scope_mismatch', issue));
};

export const makeAccessWorkloadBindingDrizzleStore = (
  database: AccessIntentDatabase,
): AccessWorkloadBindingStoreService => {
  const registerBindings: AccessWorkloadBindingStoreService['registerBindings'] = Effect.fn(
    'AccessWorkloadBindingStore.registerBindings',
  )(function* registerBindingsEffect(scope: OperationalScope, input: RegisterWorkloadBindingsInput) {
    return yield* writeWorkloadBindings(database, scope, input);
  });

  const revokeBinding: AccessWorkloadBindingStoreService['revokeBinding'] = Effect.fn(
    'AccessWorkloadBindingStore.revokeBinding',
  )(function* revokeBindingEffect(scope: OperationalScope, input: RevokeWorkloadBindingInput) {
    yield* runScoped(database, scope, OWNER_UNIQUE_CONSTRAINTS, (transaction) =>
      lockWorkloadAuthority(transaction, scope).pipe(
        Effect.andThen(() =>
          transaction
            .update(accessWorkloadBindings)
            .set({ revokedAt: input.revokedAt, status: 'revoked' })
            .where(
              and(
                eq(accessWorkloadBindings.tenantId, scope.tenantId),
                eq(accessWorkloadBindings.bindingId, input.bindingId),
                eq(accessWorkloadBindings.status, 'active'),
              ),
            )
            .pipe(durable(OWNER_UNIQUE_CONSTRAINTS), Effect.asVoid),
        ),
      ),
    );
  });

  return Object.freeze({ registerBindings, revokeBinding });
};

export const AccessWorkloadBindingStoreLive: Layer.Layer<
  AccessWorkloadBindingStore,
  never,
  CoreDatabase | DatabaseIdentityEnrollmentContext
> = Layer.effect(
  AccessWorkloadBindingStore,
  Effect.gen(function* accessWorkloadBindingStoreLayer() {
    const database = yield* CoreDatabase;
    const enrollment = yield* DatabaseIdentityEnrollmentContext;
    return makeAccessWorkloadBindingDrizzleStore({ enrollment, executor: database.executor });
  }),
);
