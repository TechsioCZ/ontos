import { v1 } from '@authzed/authzed-node';
import { Context, Effect, Layer } from 'effect';

import { AccessProjectionWriter, isFenceBusy } from '../access/intent/projection-writer.ts';
import type { TenantProjectionWrite } from '../access/intent/projection-writer.ts';
import type { AgentOperatorCommand } from '../modules/actions/agent-operator-command.ts';
import type { OperationalScope } from '../operations/context.ts';
import { ActionAuthorizationLifecycleError } from './action-authorization-lifecycle-error.ts';
import { TenantProjectionBusyError } from './tenant-projection-busy-error.ts';

/**
 * The retired v1 credential edges of one principal, as a reviewed cutover artifact describes them. No
 * runtime path writes these: authorization v2 projects `principal`/`access_human` relations from
 * PostgreSQL intent, so only the one-time cutover tooling that reads a reviewed plan calls this.
 */
export const buildPrincipalSelfCredentialUpdates = (input: {
  readonly kind: string;
  readonly principalId: string;
  readonly status: string;
  readonly tenantActive: boolean;
  readonly tenantId: string;
}): readonly v1.RelationshipUpdate[] => [
  v1.RelationshipUpdate.create({
    operation: v1.RelationshipUpdate_Operation.TOUCH,
    relationship: {
      relation: 'tenant',
      resource: { objectId: input.principalId, objectType: 'principal' },
      subject: { object: { objectId: input.tenantId, objectType: 'tenant' } },
    },
  }),
  v1.RelationshipUpdate.create({
    operation:
      input.kind === 'human' && input.status === 'active' && input.tenantActive
        ? v1.RelationshipUpdate_Operation.TOUCH
        : v1.RelationshipUpdate_Operation.DELETE,
    relationship: {
      relation: 'self',
      resource: { objectId: input.principalId, objectType: 'principal' },
      subject: { object: { objectId: input.principalId, objectType: 'principal' } },
    },
  }),
];

/** Separate provenance prevents company departure from deleting independent tenant admission. */
export const buildCompanyTenantAdmissionUpdate = (input: {
  readonly membershipUpdates: readonly v1.RelationshipUpdate[];
  readonly principalId: string;
  readonly tenantId: string;
}): v1.RelationshipUpdate =>
  v1.RelationshipUpdate.create({
    operation: input.membershipUpdates.some((update) => update.operation === v1.RelationshipUpdate_Operation.TOUCH)
      ? v1.RelationshipUpdate_Operation.TOUCH
      : v1.RelationshipUpdate_Operation.DELETE,
    relationship: {
      relation: 'company_member',
      resource: { objectId: input.tenantId, objectType: 'tenant' },
      subject: { object: { objectId: input.principalId, objectType: 'principal' } },
    },
  });

interface CurrentAgentOperatorState {
  readonly activeHumanIds: readonly string[];
  readonly command: AgentOperatorCommand | null;
  readonly companyActive: boolean;
}

/**
 * The reviewed operator set of one agent, as a cutover artifact describes it. A no-command agent keeps
 * its pre-native operators (`null`); an archived one keeps none. Inert data for the cutover tooling.
 */
export const deriveCurrentAgentOperatorSet = (
  input: CurrentAgentOperatorState & {
    readonly companyMemberIds: readonly string[];
    readonly status: string;
    readonly tenantActive: boolean;
  },
): readonly string[] | null => {
  if (input.status === 'archived') {
    return [];
  }
  if (input.command === null) {
    return null;
  }
  const members = new Set(input.companyMemberIds);
  if (
    !input.tenantActive ||
    input.status !== 'active' ||
    !input.companyActive ||
    !members.has(input.command.agentPrincipalId)
  ) {
    return [];
  }
  const activeHumans = new Set(input.activeHumanIds);
  return input.command.desiredOperatorPrincipalIds.filter((id) => activeHumans.has(id) && members.has(id));
};

export interface ActionAuthorizationLifecycleService {
  /**
   * Brings one tenant's whole projection in line with live intent (D9, D24). This is the v2 semantics of
   * every Core lifecycle wake-up: a tenant is projected whole, so a principal change, a role change, a
   * binding activation and a module installation are all the same reconcile under the tenant's own scope
   * fence. There is no per-principal, per-role or per-tenant-Action second writer, and no `scoped_role` or
   * explicit Action-grant graph: the caller passes the trusted scope it already resolved, and the single
   * Core writer reads one complete tenant intent, plans it, writes the minimal difference and verifies it.
   */
  readonly reconcileTenant: (
    scope: OperationalScope,
  ) => Effect.Effect<TenantProjectionWrite, ActionAuthorizationLifecycleError | TenantProjectionBusyError>;
}

export class ActionAuthorizationLifecycle extends Context.Service<
  ActionAuthorizationLifecycle,
  ActionAuthorizationLifecycleService
>()('@app/core-runtime/permissions/action-authorization-lifecycle/ActionAuthorizationLifecycle') {}

const reconcileFailed = (cause: unknown): ActionAuthorizationLifecycleError =>
  new ActionAuthorizationLifecycleError({
    cause,
    reason: 'The tenant projection could not be reconciled from live access intent',
  });

/** The one writer as this seam uses it: the writer itself owns fence, journal, plan and verification. */
export const ActionAuthorizationLifecycleLive: Layer.Layer<
  ActionAuthorizationLifecycle,
  never,
  AccessProjectionWriter
> = Layer.effect(
  ActionAuthorizationLifecycle,
  AccessProjectionWriter.pipe(
    Effect.map((writer): ActionAuthorizationLifecycleService =>
      Object.freeze({
        reconcileTenant: (scope: OperationalScope) =>
          writer.reconcileTenant({ scope }).pipe(
            // A busy fence is translated once, here at the writer's edge, so a caller can wait for the other writer
            // by its tag instead of inspecting the writer's failure.
            Effect.mapError((refusal) =>
              isFenceBusy(refusal)
                ? new TenantProjectionBusyError({ reason: refusal.reason })
                : reconcileFailed(refusal),
            ),
          ),
      }),
    ),
  ),
);
