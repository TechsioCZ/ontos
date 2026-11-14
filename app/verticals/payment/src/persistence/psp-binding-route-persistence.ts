import { defineScopedRoutine } from '@app/core-runtime';
import type { ScopedTransactionExecutor } from '@app/core-runtime';
import type { RegisteredGatewayRouteScope } from '@app/core-runtime/auth/system-principal-context-provenance';
import { and, eq } from 'drizzle-orm';
import { Effect, Option, Schema } from 'effect';

import { ProviderBindingRouteResponseSchema } from '../../shared/apis/provider-binding-route.ts';
import type { ProviderBindingRouteKey } from '../../shared/apis/provider-binding-route.ts';
import { paymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import type { PaymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import type { PaymentGatewayProviderFamilySchema } from '../../shared/domain/payment-vocabulary.ts';
import { GatewayProviderAccountRefSchema } from '../../shared/domain/psp-configuration.ts';
import type {
  GatewayProviderAccountBindingId,
  GatewayProviderAccountRef,
} from '../../shared/domain/psp-configuration.ts';
import type { GatewayEnvironment } from '../../shared/domain/psp-vocabulary.ts';
import { pspBindingRoutes, pspProviderAccountBindings } from '../database/schema.ts';

/**
 * Provider binding routes (#1157, phase 2 D-P4/D-P5). A route ties one opaque route key to exactly one
 * Provider Account Binding of one Selling Legal Entity. It is written once, with the binding, and never
 * changes; a retired binding keeps its route.
 *
 * - The workload-only route Read resolves a key inside the caller's Tenant through
 *   `payment.psp_resolve_binding_route`: the Read has no Legal Entity scope, and binding rows are Legal
 *   Entity scoped, so the routine reads the binding identity for exactly the Tenant the transaction is in.
 * - Capture and recovery (A10) recheck a Shell-signed route scope against the route of the binding it names,
 *   read in their own Selling Legal Entity scope (AUTHORIZATION.md:127).
 */

/** The Shell route-scope key every Payment binding route scope carries (Shell: `routeScopeKey`). */
export const PROVIDER_BINDING_ROUTE_SCOPE_KEY = 'provider-binding-route';

/** A route key resolved in the caller's Tenant: the frozen Read answer without its fixed operations. */
const routeFields = ProviderBindingRouteResponseSchema.fields;
export const ProviderBindingRouteRecordSchema = Schema.Struct({
  bindingId: routeFields.bindingId,
  bindingRef: routeFields.bindingRef,
  bindingStatus: routeFields.bindingStatus,
  environment: routeFields.environment,
  legalEntityId: routeFields.legalEntityId,
  providerFamily: routeFields.providerFamily,
  routeRevision: routeFields.routeRevision,
  tenantId: routeFields.tenantId,
});
export type ProviderBindingRouteRecord = typeof ProviderBindingRouteRecordSchema.Type;

/** The route of one binding with the binding's account identity, as an owner Action rechecks it. */
export interface BoundProviderBindingRoute {
  readonly bindingId: GatewayProviderAccountBindingId;
  readonly environment: GatewayEnvironment;
  readonly providerAccountRef: GatewayProviderAccountRef;
  readonly providerFamily: typeof PaymentGatewayProviderFamilySchema.Type;
  readonly routeRevision: number;
}

const resolveBindingRouteRoutine = defineScopedRoutine({
  name: 'psp_resolve_binding_route',
  ownerModuleKey: 'payment.core',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'input', type: 'text' },
  ] as const,
  resultSchema: Schema.Struct({ result: Schema.toEncoded(ProviderBindingRouteRecordSchema) }),
  routineKey: 'psp.resolve-binding-route',
  schema: 'payment',
});

const readFailure = (cause: unknown) => paymentUnavailable('The provider binding route could not be read', cause);
const storedFailure = (cause: unknown) =>
  paymentUnavailable('A stored provider binding route does not match its contract', cause);

const decodeRecord = Schema.decodeUnknownEffect(ProviderBindingRouteRecordSchema);
const decodeBoundRoute = Schema.decodeUnknownEffect(
  Schema.Struct({
    bindingId: routeFields.bindingId,
    environment: routeFields.environment,
    providerAccountRef: GatewayProviderAccountRefSchema,
    providerFamily: routeFields.providerFamily,
    routeRevision: routeFields.routeRevision,
  }),
);

/**
 * Construction is private to the route Read's Core-owned Tenant transaction. `resolveRouteKey` answers the route
 * with this key in the transaction's Tenant (any of its Legal Entities), or None when it is unknown there.
 */
export const pspBindingRouteKeyReaderForTransaction = (transaction: ScopedTransactionExecutor) => {
  const resolveRouteKey = Effect.fn('PspBindingRoutePersistence.resolveRouteKey')(function* resolveRouteKey(
    routeKey: ProviderBindingRouteKey,
  ): Effect.fn.Return<Option.Option<ProviderBindingRouteRecord>, PaymentUnavailable> {
    if (transaction.scope.legalEntityId !== undefined) {
      return yield* paymentUnavailable('A binding route resolves only in a Tenant scope without a Legal Entity');
    }
    const rows = yield* transaction.invoke(resolveBindingRouteRoutine, [routeKey]).pipe(Effect.mapError(readFailure));
    if (rows.length > 1) {
      return yield* paymentUnavailable('A route key resolved to more than one binding route');
    }
    const [row] = rows;
    if (row === undefined) {
      return Option.none<ProviderBindingRouteRecord>();
    }
    const record = yield* decodeRecord(row.result).pipe(Effect.mapError(storedFailure));
    return record.tenantId === transaction.scope.tenantId
      ? Option.some(record)
      : yield* paymentUnavailable('A binding route of another Tenant was returned');
  });
  return Object.freeze({ resolveRouteKey });
};
export type PspBindingRouteKeyReader = ReturnType<typeof pspBindingRouteKeyReaderForTransaction>;

/**
 * Construction is private to a Core-owned Selling Legal Entity transaction (capture, recovery).
 * `readRouteOfBinding` answers the route of this binding in the transaction's Tenant and Selling Legal Entity,
 * or None when it has none there.
 */
export const pspBindingRouteReaderForTransaction = (transaction: ScopedTransactionExecutor) => {
  const readRouteOfBinding = Effect.fn('PspBindingRoutePersistence.readRouteOfBinding')(function* readRouteOfBinding(
    bindingId: string,
  ): Effect.fn.Return<Option.Option<BoundProviderBindingRoute>, PaymentUnavailable> {
    const { legalEntityId, tenantId } = transaction.scope;
    if (legalEntityId === undefined) {
      return yield* paymentUnavailable('A verified Selling Legal Entity scope is required');
    }
    const rows = yield* transaction
      .select({
        bindingId: pspBindingRoutes.bindingId,
        environment: pspBindingRoutes.environment,
        providerAccountRef: pspProviderAccountBindings.providerAccountRef,
        providerFamily: pspBindingRoutes.providerFamily,
        routeRevision: pspBindingRoutes.routeRevision,
      })
      .from(pspBindingRoutes)
      .innerJoin(
        pspProviderAccountBindings,
        and(
          eq(pspProviderAccountBindings.tenantId, pspBindingRoutes.tenantId),
          eq(pspProviderAccountBindings.legalEntityId, pspBindingRoutes.legalEntityId),
          eq(pspProviderAccountBindings.bindingId, pspBindingRoutes.bindingId),
          eq(pspProviderAccountBindings.providerFamily, pspBindingRoutes.providerFamily),
          eq(pspProviderAccountBindings.environment, pspBindingRoutes.environment),
        ),
      )
      .where(
        and(
          eq(pspBindingRoutes.tenantId, tenantId),
          eq(pspBindingRoutes.legalEntityId, legalEntityId),
          eq(pspBindingRoutes.bindingId, bindingId),
        ),
      )
      .pipe(Effect.mapError(readFailure));
    const [row] = rows;
    if (row === undefined) {
      return Option.none<BoundProviderBindingRoute>();
    }
    const route: BoundProviderBindingRoute = yield* decodeBoundRoute(row).pipe(Effect.mapError(storedFailure));
    return Option.some(route);
  });
  return Object.freeze({ readRouteOfBinding });
};
export type PspBindingRouteReader = ReturnType<typeof pspBindingRouteReaderForTransaction>;

/**
 * Whether a Shell-signed route scope names exactly this binding route in this Tenant and Selling Legal Entity:
 * the Payment route-scope key, the binding as route and source route, and the route's own revision.
 */
export const routeScopeNamesBindingRoute = (
  proof: RegisteredGatewayRouteScope,
  route: Pick<BoundProviderBindingRoute, 'bindingId' | 'routeRevision'>,
  scope: { readonly legalEntityId: string; readonly tenantId: string },
): boolean => {
  const revision = String(route.routeRevision);
  return (
    proof.routeKey === PROVIDER_BINDING_ROUTE_SCOPE_KEY &&
    proof.routeId === route.bindingId &&
    proof.sourceRouteId === route.bindingId &&
    proof.routeRevision === revision &&
    proof.sourceRouteRevision === revision &&
    proof.tenantId === scope.tenantId &&
    proof.legalEntityId === scope.legalEntityId
  );
};
