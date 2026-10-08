import { Context, Effect, Layer, Schema } from 'effect';
import type { DateTime } from 'effect';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import type { OperationalScope } from '../operations/context.ts';
import type { BusinessAccessTarget, AssortmentPermissionAccessTarget, ResourceAccessTarget } from './context-access.ts';
import type { LegalEntityPermissionKey, TenantPermissionKey } from './context-permissions.ts';
import type { BusinessPermissionCode } from './business-permission.ts';

/**
 * Owner-local authorization is deliberately a small Core seam. Core owns the lifecycle and
 * transaction, while an owner supplies the decision for its canonical state. The owner adapter
 * must read through the supplied scoped transaction so a mutation cannot authorize against a
 * snapshot that is later changed before the handler commits.
 */
export const OwnerAuthorizationDecisionSchema = Schema.Literals(['allowed', 'denied', 'unavailable']);
export type OwnerAuthorizationDecision = typeof OwnerAuthorizationDecisionSchema.Type;

export type OwnerAuthorizationTarget =
  | Readonly<{
      readonly kind: 'business_permission';
      readonly permission: BusinessPermissionCode;
      readonly target: BusinessAccessTarget;
      readonly trustedStorefrontId?: string;
    }>
  | Readonly<{
      readonly kind: 'assortment_permission';
      readonly target: AssortmentPermissionAccessTarget;
      readonly trustedStorefrontId?: string;
    }>
  | Readonly<{
      readonly kind: 'legal_entity';
      readonly legalEntityId: string;
      readonly permission?: LegalEntityPermissionKey;
    }>
  | Readonly<{
      readonly kind: 'module';
      readonly legalEntityId?: string;
      readonly moduleId: string;
    }>
  | Readonly<{
      readonly kind: 'resource';
      readonly permission: 'read' | 'write';
      readonly resource: ResourceAccessTarget;
    }>
  | Readonly<{
      readonly kind: 'tenant';
      readonly permission: TenantPermissionKey;
      readonly tenantId: string;
    }>;

export interface OwnerAuthorizationInput {
  readonly operation: 'action' | 'read';
  /** Core-minted PostgreSQL transaction start time; never derived from request input. */
  readonly operationAt: DateTime.Utc;
  readonly operationKey: string;
  readonly owningModuleKey: string;
  readonly scope: OperationalScope;
  /**
   * Targets are the decoded, Core-validated authorization targets. Alternative targets remain
   * in declaration order so an owner can apply its positive-union semantics without trusting
   * transport metadata or business payloads.
   */
  readonly targets: readonly OwnerAuthorizationTarget[];
}

export interface OwnerAuthorizationOverlayService {
  readonly authorize: (
    transaction: ScopedTransactionExecutor,
    input: OwnerAuthorizationInput,
  ) => Effect.Effect<OwnerAuthorizationDecision>;
}

export class OwnerAuthorizationOverlay extends Context.Service<
  OwnerAuthorizationOverlay,
  OwnerAuthorizationOverlayService
>()('@app/core-runtime/permissions/owner-authorization-overlay/OwnerAuthorizationOverlay') {}

/** The explicit default keeps deployments without owner state fail-safe for owner-neutral targets. */
export const allowOwnerAuthorizationOverlay: OwnerAuthorizationOverlayService = Object.freeze({
  authorize: () => Effect.succeed('allowed' as const),
});

/**
 * The production-safe fallback for deployments that do not install an owner adapter.
 *
 * Core can authorize tenant, module, Legal Entity, and Resource targets on its own. Business
 * targets are different: their canonical state belongs to the owning MicroVertical, so silently
 * treating an omitted owner adapter as an allow would turn a partial deployment into an
 * authorization bypass. Keep this fallback deliberately small and target-based; owner-neutral
 * operations remain available while every owner-governed target fails closed as unavailable.
 *
 * A TAX Selling Legal Entity target names no owner-held record: it is a Core Legal Entity, so Core
 * decides it alone, but only while it is the exact Legal Entity of the trusted scope.
 */
const isCoreDecidedBusinessTarget = (
  target: Extract<OwnerAuthorizationTarget, { readonly kind: 'business_permission' }>,
  scope: OperationalScope,
): boolean =>
  target.target.kind === 'tax_selling_legal_entity' &&
  target.target.tenantId === scope.tenantId &&
  target.target.legalEntityId === scope.legalEntityId;

export const failClosedOwnerAuthorizationDecision = (input: OwnerAuthorizationInput): OwnerAuthorizationDecision =>
  input.targets.some(
    (target) =>
      target.kind === 'assortment_permission' ||
      (target.kind === 'business_permission' && !isCoreDecidedBusinessTarget(target, input.scope)),
  )
    ? 'unavailable'
    : 'allowed';

export const failClosedOwnerAuthorizationOverlay: OwnerAuthorizationOverlayService = Object.freeze({
  authorize: (_transaction: ScopedTransactionExecutor, input: OwnerAuthorizationInput) =>
    Effect.succeed(failClosedOwnerAuthorizationDecision(input)),
});

export const OwnerAuthorizationOverlayAllowLive = Layer.succeed(
  OwnerAuthorizationOverlay,
  allowOwnerAuthorizationOverlay,
);
