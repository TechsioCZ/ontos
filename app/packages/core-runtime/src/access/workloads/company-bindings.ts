import { and, eq } from 'drizzle-orm';
import { Effect, Layer } from 'effect';

import { CoreDatabase } from '../../db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../../db/database-identities.ts';
import { accessWorkloadCompanyBindings } from '../../db/schema.ts';
import type { CoreTransaction } from '../../db/types.ts';
import type { OperationalScope } from '../../operations/context.ts';
import { intentConflict } from '../intent/errors.ts';
import type { AccessIntentConflictCode } from '../intent/errors/conflict-error.ts';
import type { AccessIntentError } from '../intent/errors.ts';
import type { AccessIntentDatabase } from '../intent/persistence.ts';
import { durable, runScoped, scopeIssue } from '../intent/persistence.ts';
import { AccessWorkloadCompanyBindingStore } from './company-store.ts';
import { lockWorkloadAuthority } from './authority-fence.ts';
import type {
  AccessWorkloadCompanyBindingStoreService,
  RegisterWorkloadCompanyBindingInput,
  RegisterWorkloadCompanyBindingsInput,
  RevokeWorkloadCompanyBindingInput,
} from './company-store.ts';

/** The unique indexes of `access_workload_company_bindings`; a collision is the same conflict as a lost compare-and-set. */
const OWNER_UNIQUE_CONSTRAINTS: ReadonlySet<string> = new Set([
  'access_workload_company_bindings_active_uk',
  'access_workload_company_bindings_incarnation_uk',
  'access_workload_company_bindings_pkey',
  'access_workload_company_bindings_tenant_id_uk',
]);

/**
 * A command that names another tenant, or that registers two companies for one workload binding, is
 * refused before SQL sees it: a binding selects exactly one company (D6), and row security would hide
 * a foreign row anyway, where a silent no-op is not an answer to a cross-tenant write.
 */
const commandIssue = (
  scope: OperationalScope,
  bindings: readonly RegisterWorkloadCompanyBindingInput[],
): { readonly code: AccessIntentConflictCode; readonly reason: string } | null => {
  const companies = new Map<string, string>();
  for (const binding of bindings) {
    const issue = scopeIssue(scope, [binding.tenantId]);
    if (issue !== null) {
      return { code: 'access_intent_scope_mismatch', reason: issue };
    }
    const named = companies.get(binding.workloadBindingId);
    if (named !== undefined && named !== binding.legalEntityId) {
      return {
        code: 'access_intent_write_refused',
        reason: `the command registers company ${binding.legalEntityId} for a workload binding that already names ${named}`,
      };
    }
    companies.set(binding.workloadBindingId, binding.legalEntityId);
  }
  return null;
};

const insertValues = (binding: RegisterWorkloadCompanyBindingInput) => ({
  companyBindingId: binding.companyBindingId,
  createdAt: binding.createdAt,
  incarnation: binding.incarnation,
  legalEntityId: binding.legalEntityId,
  revokedAt: null,
  status: 'active' as const,
  tenantId: binding.tenantId,
  workloadBindingId: binding.workloadBindingId,
});

const writeCompanyBindingRows = (
  transaction: CoreTransaction,
  bindings: readonly RegisterWorkloadCompanyBindingInput[],
): Effect.Effect<void, AccessIntentError> =>
  bindings.length === 0
    ? Effect.void
    : transaction
        .insert(accessWorkloadCompanyBindings)
        .values(bindings.map(insertValues))
        // A bootstrap is idempotent: a registration that already exists (active or revoked) stays as it
        // is, so a re-run never revives what an administrator ended (D27). Only the primary key is
        // ignored, so a registration that names a second company for a binding that already holds one
        // violates the live-registration unique index and is refused, never silently dropped.
        .onConflictDoNothing({ target: [accessWorkloadCompanyBindings.companyBindingId] })
        .pipe(durable(OWNER_UNIQUE_CONSTRAINTS), Effect.asVoid);

/**
 * Registers active company registrations in the caller's own scope, refusing a command that names
 * another tenant or two companies for one binding. A bootstrap writer (the stage and local
 * installers) calls this directly with the Core executor it already holds, exactly as it writes the
 * workload bindings; the service below is the same write through the bound
 * `AccessWorkloadCompanyBindingStore` for callers that resolve it from context.
 */
export const writeWorkloadCompanyBindings = (
  database: AccessIntentDatabase,
  scope: OperationalScope,
  input: RegisterWorkloadCompanyBindingsInput,
): Effect.Effect<void, AccessIntentError> => {
  const issue = commandIssue(scope, input.bindings);
  return issue === null
    ? runScoped(database, scope, OWNER_UNIQUE_CONSTRAINTS, (transaction) =>
        lockWorkloadAuthority(transaction, scope).pipe(
          Effect.andThen(() => writeCompanyBindingRows(transaction, input.bindings)),
        ),
      )
    : Effect.fail(intentConflict(issue.code, issue.reason));
};

export const makeAccessWorkloadCompanyBindingDrizzleStore = (
  database: AccessIntentDatabase,
): AccessWorkloadCompanyBindingStoreService => {
  const registerCompanyBindings: AccessWorkloadCompanyBindingStoreService['registerCompanyBindings'] = Effect.fn(
    'AccessWorkloadCompanyBindingStore.registerCompanyBindings',
  )(function* registerCompanyBindingsEffect(scope: OperationalScope, input: RegisterWorkloadCompanyBindingsInput) {
    return yield* writeWorkloadCompanyBindings(database, scope, input);
  });

  const revokeCompanyBinding: AccessWorkloadCompanyBindingStoreService['revokeCompanyBinding'] = Effect.fn(
    'AccessWorkloadCompanyBindingStore.revokeCompanyBinding',
  )(function* revokeCompanyBindingEffect(scope: OperationalScope, input: RevokeWorkloadCompanyBindingInput) {
    yield* runScoped(database, scope, OWNER_UNIQUE_CONSTRAINTS, (transaction) =>
      lockWorkloadAuthority(transaction, scope).pipe(
        Effect.andThen(() =>
          transaction
            .update(accessWorkloadCompanyBindings)
            .set({ revokedAt: input.revokedAt, status: 'revoked' })
            .where(
              and(
                eq(accessWorkloadCompanyBindings.tenantId, scope.tenantId),
                eq(accessWorkloadCompanyBindings.companyBindingId, input.companyBindingId),
                eq(accessWorkloadCompanyBindings.status, 'active'),
              ),
            )
            .pipe(durable(OWNER_UNIQUE_CONSTRAINTS), Effect.asVoid),
        ),
      ),
    );
  });

  return Object.freeze({ registerCompanyBindings, revokeCompanyBinding });
};

export const AccessWorkloadCompanyBindingStoreLive: Layer.Layer<
  AccessWorkloadCompanyBindingStore,
  never,
  CoreDatabase | DatabaseIdentityEnrollmentContext
> = Layer.effect(
  AccessWorkloadCompanyBindingStore,
  Effect.gen(function* accessWorkloadCompanyBindingStoreLayer() {
    const database = yield* CoreDatabase;
    const enrollment = yield* DatabaseIdentityEnrollmentContext;
    return makeAccessWorkloadCompanyBindingDrizzleStore({ enrollment, executor: database.executor });
  }),
);
