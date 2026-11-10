import { defineDatabaseIdentityEnrollment } from '@app/core-runtime';
import { and, eq, isNull } from 'drizzle-orm';
import { DateTime, Effect, Match, Schema } from 'effect';

import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import type { PaymentExecutionBinding } from '../../shared/domain/payment-execution-binding.ts';
import type { PaymentMethod, PaymentSourceKind } from '../../shared/domain/payment-vocabulary.ts';
import { PaymentRefundExecutionRouteSchema } from '../../shared/domain/refund-contract.ts';
import type { PaymentRefundRouteKind } from '../../shared/domain/refund-contract.ts';
import { sourceAuthorities, sourceAuthorityRevisions } from '../../src/database/schema.ts';
import { operationalScopeOf, provenanceFor } from '../integration/database-fixture.ts';
import type { PaymentTestDatabase, PaymentTestScope } from '../integration/database-fixture.ts';

/**
 * Every REFUND row stores the configured refund executor it was requested through (#1150/#1152).
 * Suites that create a REFUND with the foundation primitive instead of `request-payment-refund`
 * derive that route from the source authority the scenario configured, exactly as the refund Action
 * records the authority it resolved.
 */

/** A configured source authority as a refund execution route names it. */
export interface ConfiguredRefundAuthority {
  readonly revision: number;
  readonly source: {
    readonly accountRef: string;
    readonly environment: string;
    readonly sourceKind: PaymentSourceKind;
    readonly sourceSystem: string;
  };
  readonly sourceAuthorityId: string;
}

/** A carrier collects COD funds and is never a refund route, so its route does not decode. */
const ROUTE_KIND_BY_SOURCE_KIND = {
  BANK_ACCOUNTING: 'BANK_ACCOUNTING',
  CARRIER: null,
  LOCAL_POS_OPERATOR: 'LOCAL_POS',
  MANUAL_EXTERNAL_REFUND: 'MANUAL_EXTERNAL',
  PAYMENT_GATEWAY: 'ORIGINAL_GATEWAY_BINDING',
} as const satisfies Record<PaymentSourceKind, PaymentRefundRouteKind | null>;

/** The route of a REFUND requested through the given configured authority at its current revision. */
export const refundExecutionRouteOf = (authority: ConfiguredRefundAuthority) =>
  Schema.decodeUnknownEffect(PaymentRefundExecutionRouteSchema)({
    accountRef: authority.source.accountRef,
    environment: authority.source.environment,
    routeKind: ROUTE_KIND_BY_SOURCE_KIND[authority.source.sourceKind],
    sourceAuthorityId: authority.sourceAuthorityId,
    sourceAuthorityRevision: authority.revision,
    sourceKind: authority.source.sourceKind,
    sourceSystem: authority.source.sourceSystem,
  });

/** A persisted `source_authorities` row as a configured refund authority. */
export const configuredRefundAuthorityOf = (row: typeof sourceAuthorities.$inferSelect): ConfiguredRefundAuthority => ({
  revision: row.revision,
  source: {
    accountRef: row.accountRef,
    environment: row.environment,
    sourceKind: row.sourceKind,
    sourceSystem: row.sourceSystem,
  },
  sourceAuthorityId: row.sourceAuthorityId,
});

interface RefundExecutorIdentity {
  readonly accountRef: string;
  readonly environment: string;
  readonly method: PaymentMethod | null;
  readonly sourceKind: PaymentSourceKind;
  readonly sourceSystem: string;
}

const MERCHANT_BANK: RefundExecutorIdentity = {
  accountRef: 'merchant-refund-account',
  environment: 'production',
  method: null,
  sourceKind: 'BANK_ACCOUNTING',
  sourceSystem: 'erp-bank',
};

/**
 * The executor a Payment collected under this binding refunds through (#1150 "Refund execution
 * authority"): the exact original gateway account, the merchant bank for bank transfer and COD
 * funds, and the local POS for pickup collections.
 */
const refundExecutorFor = (binding: PaymentExecutionBinding): RefundExecutorIdentity =>
  Match.valueTags(binding, {
    BANK_ACCOUNTING_RECEIPT: () => MERCHANT_BANK,
    COD_DELIVERY_OFFER: () => MERCHANT_BANK,
    GATEWAY_ACCOUNT: (gateway): RefundExecutorIdentity => ({
      accountRef: gateway.providerAccountRef,
      environment: gateway.environment,
      method: 'ONLINE_GATEWAY',
      sourceKind: 'PAYMENT_GATEWAY',
      sourceSystem: gateway.providerFamily,
    }),
    PICKUP_CAPABILITY: (): RefundExecutorIdentity => ({
      accountRef: 'pos-drawer-refunds',
      environment: 'production',
      method: 'PAY_ON_PICKUP_OR_ON_SITE',
      sourceKind: 'LOCAL_POS_OPERATOR',
      sourceSystem: 'store-pos',
    }),
  });

type ScopedTransaction = Effect.Success<ReturnType<typeof installOperationalScope>>;

/** The executor's authority row of this scope, configured with its first revision when it is new. */
const findOrConfigureExecutor = Effect.fn('RefundExecutionRouteFixture.findOrConfigureExecutor')(
  function* findOrConfigureExecutor(
    transaction: ScopedTransaction,
    scope: PaymentTestScope,
    executor: RefundExecutorIdentity,
  ) {
    const [existing] = yield* transaction
      .select()
      .from(sourceAuthorities)
      .where(
        and(
          eq(sourceAuthorities.tenantId, scope.tenantId),
          eq(sourceAuthorities.legalEntityId, scope.legalEntityId),
          eq(sourceAuthorities.factFamily, 'REFUND_EXECUTION'),
          executor.method === null ? isNull(sourceAuthorities.method) : eq(sourceAuthorities.method, executor.method),
          eq(sourceAuthorities.sourceKind, executor.sourceKind),
          eq(sourceAuthorities.sourceSystem, executor.sourceSystem),
          eq(sourceAuthorities.accountRef, executor.accountRef),
          eq(sourceAuthorities.environment, executor.environment),
        ),
      );
    if (existing !== undefined) {
      return existing;
    }
    const provenance = yield* provenanceFor(scope);
    const [created] = yield* transaction
      .insert(sourceAuthorities)
      .values({
        ...executor,
        actionInvocationId: provenance.actionInvocationId,
        actorPrincipalId: provenance.actorPrincipalId,
        compositionRevision: provenance.compositionRevision,
        configuredAt: DateTime.toDateUtc(yield* DateTime.now),
        factFamily: 'REFUND_EXECUTION',
        legalEntityId: scope.legalEntityId,
        reason: 'Configured refund execution route',
        refundRoute: true,
        revision: 1,
        status: 'ACTIVE',
        tenantId: scope.tenantId,
      })
      .returning();
    const row = yield* Effect.fromNullishOr(created);
    // Its first revision binds the scope principal as the executor's submitting principal.
    yield* transaction.insert(sourceAuthorityRevisions).values({
      actionInvocationId: row.actionInvocationId,
      actorPrincipalId: row.actorPrincipalId,
      compositionRevision: row.compositionRevision,
      legalEntityId: row.legalEntityId,
      reason: row.reason,
      recordedAt: row.configuredAt,
      refundRoute: row.refundRoute,
      revision: row.revision,
      sourceAuthorityId: row.sourceAuthorityId,
      status: row.status,
      submitterPrincipalIds: [scope.principalId],
      tenantId: row.tenantId,
    });
    return row;
  },
);

/**
 * Configures (once per scope) the ACTIVE refund execution authority of a Payment collected under the
 * given binding, as the source-authority Action persists it, and returns the route a REFUND of that
 * Payment stores.
 */
export const configuredRefundExecutionRouteFor = (
  database: PaymentTestDatabase,
  scope: PaymentTestScope,
  binding: PaymentExecutionBinding,
) =>
  database
    .transaction((transaction) =>
      installOperationalScope(transaction, operationalScopeOf(scope), defineDatabaseIdentityEnrollment([])).pipe(
        Effect.flatMap((scoped) => findOrConfigureExecutor(scoped, scope, refundExecutorFor(binding))),
      ),
    )
    .pipe(Effect.flatMap((row) => refundExecutionRouteOf(configuredRefundAuthorityOf(row))));
