import { eq, sql } from 'drizzle-orm';
import { Context, Effect, Layer, Schema } from 'effect';
import { SqlError } from 'effect/unstable/sql/SqlError';

import { CoreDatabase } from '../db/client.ts';
import { tenants } from '../db/schema.ts';
import { scopedRoutineInvokerFromTransaction } from '../db/scoped-routine.ts';
import type { ScopedRoutineInvoker } from '../db/scoped-routine.ts';
import type { CoreDatabaseExecutor, CoreTransaction } from '../db/types.ts';
import { outboxWorkerCompletionPublisherFor, persistOutboxWorkerCompletion } from './completion-publication.ts';
import type { OutboxWorkerCompletionPublisher } from './completion-publication.ts';
import type { OutboxWorkerHandlerContext } from './definition.ts';
import { isVerifiedOutboxWorkerHandlerContext } from './definition.ts';
import { OutboxWorkerTenantScopeError } from './tenant-scope-error.ts';
import { lifetimeBoundOutboxWorkerOwnerCapabilities } from './worker-owner-scope-lifetime.ts';

export { OutboxWorkerTenantScopeError } from './tenant-scope-error.ts';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const tenantStatuses = ['active', 'archived', 'suspended'] as const;

export interface OutboxWorkerTenantScopeView {
  readonly completionPublisher: OutboxWorkerCompletionPublisher;
  readonly routineInvoker: ScopedRoutineInvoker;
  readonly tenantId: string;
}

export interface OutboxWorkerTenantScopeBackend {
  readonly run: <OwnerError, OwnerRequirements>(
    context: OutboxWorkerHandlerContext,
    observe: (scope: OutboxWorkerTenantScopeView) => Effect.Effect<void, OwnerError, OwnerRequirements>,
  ) => Effect.Effect<void, OwnerError | OutboxWorkerTenantScopeError, OwnerRequirements>;
}

export interface OutboxWorkerTenantScopeService {
  readonly run: <OwnerError, OwnerRequirements>(
    context: OutboxWorkerHandlerContext,
    observe: (scope: OutboxWorkerTenantScopeView) => Effect.Effect<void, OwnerError, OwnerRequirements>,
  ) => Effect.Effect<void, OwnerError | OutboxWorkerTenantScopeError, OwnerRequirements>;
}

export class OutboxWorkerTenantScope extends Context.Service<OutboxWorkerTenantScope, OutboxWorkerTenantScopeService>()(
  '@app/core-runtime/outbox/tenant-scope/OutboxWorkerTenantScope',
) {}

const invalid = () =>
  new OutboxWorkerTenantScopeError({
    code: 'outbox_worker_tenant_scope_context_invalid',
    reason: 'Tenant-only execution requires a verified forbidden-Legal-Entity Outbox Worker claim',
    retryable: false,
  });

const unavailable = (cause?: unknown) => {
  const failure = new OutboxWorkerTenantScopeError({
    code: 'outbox_worker_tenant_scope_unavailable',
    reason: 'Tenant-only worker scope is temporarily unavailable',
    retryable: true,
  });
  return cause === undefined
    ? failure
    : Object.defineProperty(failure, 'cause', {
        configurable: false,
        enumerable: false,
        value: cause,
        writable: false,
      });
};

const hasVerifiedTenantOnlyContext = (context: OutboxWorkerHandlerContext): boolean =>
  isVerifiedOutboxWorkerHandlerContext(context) &&
  context.legalEntityScope === 'forbidden' &&
  uuidPattern.test(context.tenantId);

export const makeOutboxWorkerTenantScope = (
  backend: OutboxWorkerTenantScopeBackend,
): OutboxWorkerTenantScopeService => ({
  run: (context, observe) =>
    hasVerifiedTenantOnlyContext(context)
      ? backend.run(context, observe).pipe(Effect.withSpan('OutboxWorker.tenantScope'))
      : Effect.fail(invalid()),
});

interface ScopeSettingRow extends Record<string, unknown> {
  readonly legal_entity_id: string;
  readonly tenant_id: string;
}

const ownerScope = (
  transaction: CoreTransaction,
  context: OutboxWorkerHandlerContext,
): Readonly<{ close: () => void; scope: OutboxWorkerTenantScopeView }> => {
  const delegate = scopedRoutineInvokerFromTransaction(
    (statement) => transaction.execute<Record<string, never>>(statement, 'objects'),
    { tenantId: context.tenantId },
  );
  const capabilities = lifetimeBoundOutboxWorkerOwnerCapabilities(
    delegate,
    outboxWorkerCompletionPublisherFor({
      context,
      legalEntityId: null,
      persist: persistOutboxWorkerCompletion(transaction),
    }),
  );
  return Object.freeze({
    close: capabilities.close,
    scope: Object.freeze({
      completionPublisher: capabilities.completionPublisher,
      routineInvoker: capabilities.routineInvoker,
      tenantId: context.tenantId,
    }),
  });
};

const makePostgresOutboxWorkerTenantScopeBackend = (database: {
  readonly executor: CoreDatabaseExecutor;
}): OutboxWorkerTenantScopeBackend => ({
  run: <OwnerError, OwnerRequirements>(
    context: OutboxWorkerHandlerContext,
    observe: (scope: OutboxWorkerTenantScopeView) => Effect.Effect<void, OwnerError, OwnerRequirements>,
  ): Effect.Effect<void, OwnerError | OutboxWorkerTenantScopeError, OwnerRequirements> =>
    database.executor
      .transaction(
        Effect.fn('OutboxWorkerTenantScope.transaction')(function* runTenantScopeTransaction(
          transaction: CoreTransaction,
        ) {
          const settings = yield* transaction
            .execute<ScopeSettingRow>(
              sql`
                select
                  set_config('ontos.tenant_id', ${context.tenantId}, true) as tenant_id,
                  set_config('ontos.legal_entity_id', '', true) as legal_entity_id
              `,
              'objects',
            )
            .pipe(Effect.mapError(unavailable));
          const [setting] = settings;
          const [tenant] = yield* transaction
            .select({ status: tenants.status, tenantId: tenants.tenantId })
            .from(tenants)
            .where(eq(tenants.tenantId, context.tenantId))
            .limit(1)
            .pipe(Effect.mapError(unavailable));
          if (
            setting?.tenant_id !== context.tenantId ||
            setting.legal_entity_id !== '' ||
            tenant?.tenantId !== context.tenantId ||
            !tenantStatuses.some((status) => status === tenant.status)
          ) {
            return yield* unavailable();
          }
          const owned = ownerScope(transaction, context);
          return yield* observe(owned.scope).pipe(Effect.ensuring(Effect.sync(owned.close)));
        }),
      )
      .pipe(Effect.mapError((failure) => (Schema.is(SqlError)(failure) ? unavailable(failure) : failure))),
});

export const OutboxWorkerTenantScopeLive = Layer.effect(
  OutboxWorkerTenantScope,
  CoreDatabase.pipe(
    Effect.map((database) => makeOutboxWorkerTenantScope(makePostgresOutboxWorkerTenantScopeBackend(database))),
  ),
);
