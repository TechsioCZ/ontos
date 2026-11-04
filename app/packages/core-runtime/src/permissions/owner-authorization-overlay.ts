import { Context, Effect, Layer, Match, Schema } from 'effect';
import type { DateTime } from 'effect';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import type { OperationalScope } from '../operations/context.ts';
import { isOwnerPermissionAccessTargetValid } from './context-access.ts';
import type { OwnerPermissionAccessTarget, ResourceAccessTarget } from './context-access.ts';
import type { LegalEntityPermissionKey, TenantPermissionKey } from './context-permissions.ts';

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
      readonly kind: 'owner_permission';
      readonly target: OwnerPermissionAccessTarget;
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
 * An owner may explicitly declare a target whose authority requires only trusted scope and Current
 * Permission, with no owner-held record. That declaration still cannot bypass scope validation.
 */
export const failClosedOwnerAuthorizationDecision = (input: OwnerAuthorizationInput): OwnerAuthorizationDecision =>
  input.targets.some((target) =>
    Match.value(target).pipe(
      Match.when(
        { kind: 'owner_permission' },
        (owner) =>
          !isOwnerPermissionAccessTargetValid(owner.target, input.scope, input.owningModuleKey) ||
          owner.target.contract.ownerStateRequired !== false,
      ),
      Match.when({ kind: 'tenant' }, () => false),
      Match.when({ kind: 'module' }, () => false),
      Match.when({ kind: 'legal_entity' }, () => false),
      Match.when({ kind: 'resource' }, () => false),
      Match.orElse(() => true),
    ),
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
