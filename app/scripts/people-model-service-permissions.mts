import { v1 } from '@authzed/authzed-node';
import { Effect, Schema, Struct } from 'effect';

import type { ActionAuthorizationProvisioningAction } from '../packages/core-runtime/src/install/action-authorization-provisioning.ts';
import type { SpiceDbRpc } from '../packages/core-runtime/src/permissions/spicedb-rpc.ts';
import { toSpiceDbActionObjectId } from '../packages/core-runtime/src/permissions/service.ts';

export const ServicePrincipalInventorySchema = Schema.Struct({
  principals: Schema.Array(
    Schema.Struct({
      kind: Schema.String,
      principal_id: Schema.String,
      status: Schema.String,
      tenant_id: Schema.String,
    }),
  ),
});

export class ServicePermissionComparisonError extends Schema.TaggedError<ServicePermissionComparisonError>()(
  'ServicePermissionComparisonError',
  { reason: Schema.String },
) {}

/** SQL inventory, not a hand-maintained allowlist, owns technical-service coverage. */
export const activeTechnicalServicePrincipals = Effect.fn('People.activeTechnicalServicePrincipals')(
  function* activeTechnicalServicePrincipalsEffect(inventory: typeof ServicePrincipalInventorySchema.Type) {
    const decoded = yield* Schema.decodeUnknownEffect(ServicePrincipalInventorySchema)(inventory);
    const services = decoded.principals.filter(
      (principal) => principal.kind === 'service' && principal.status === 'active',
    );
    if (
      services.length === 0 ||
      new Set(services.map((principal) => principal.principal_id)).size !== services.length
    ) {
      return yield* new ServicePermissionComparisonError({
        reason: 'Expected nonempty unique active service identities',
      });
    }
    return services.map((principal) => ({ principalId: principal.principal_id, tenantId: principal.tenant_id }));
  },
);

export interface ServicePermissionCase {
  readonly after: { readonly permission: string; readonly resource: v1.ObjectReference };
  readonly before: { readonly permission: string; readonly resource: v1.ObjectReference };
  readonly kind: string;
}

/** Tenant Actions once; company Actions in every exact archived admission, never an inferred company. */
export const serviceActionPermissionCases = (
  actions: readonly ActionAuthorizationProvisioningAction[],
  tenantId: string,
  legalEntityIds: readonly string[],
) =>
  actions.flatMap((action) =>
    (action.legalEntityScope === 'forbidden' ? [undefined] : [...new Set(legalEntityIds)]).map((legalEntityId) => ({
      actionKey: action.actionKey,
      kind: 'scoped_action',
      legalEntityScope: action.legalEntityScope,
      owningModuleKey: action.owningModuleKey,
      tenantId,
      ...Struct.pick({ legalEntityId }, ['legalEntityId']),
      after: {
        permission: 'execute',
        resource: {
          objectId: toSpiceDbActionObjectId({
            actionKey: action.actionKey,
            tenantId,
            ...Struct.pick({ legalEntityId }, ['legalEntityId']),
          }),
          objectType: 'action',
        },
      },
      before: {
        permission: 'execute',
        resource: { objectId: `ak_${Buffer.from(action.actionKey).toString('base64url')}`, objectType: 'action' },
      },
    })),
  );

/** Read-only native checks at caller-pinned historical/current revisions; errors never become denials. */
export const compareNativeServicePermissions = Effect.fn('People.compareNativeServicePermissions')(
  function* compareNativeServicePermissionsEffect<Case extends ServicePermissionCase>(
    rpc: Pick<SpiceDbRpc, 'checkBulkPermissions'>,
    cases: readonly Case[],
    principalId: string,
    beforeConsistency: v1.Consistency,
    afterConsistency: v1.Consistency,
  ) {
    if (
      cases.length === 0 ||
      beforeConsistency.requirement.oneofKind !== 'atExactSnapshot' ||
      beforeConsistency.requirement.atExactSnapshot.token.length === 0 ||
      afterConsistency.requirement.oneofKind !== 'atExactSnapshot' ||
      afterConsistency.requirement.atExactSnapshot.token.length === 0
    ) {
      return yield* new ServicePermissionComparisonError({
        reason: 'Nonempty cases and two pinned native revisions are required',
      });
    }
    const evaluate = Effect.fn('People.evaluateServicePermissions')(function* evaluateServicePermissions(
      side: 'before' | 'after',
      consistency: v1.Consistency,
    ) {
      const values: boolean[] = [];
      for (let offset = 0; offset < cases.length; offset += 200) {
        const items = cases.slice(offset, offset + 200).map((item) =>
          v1.CheckBulkPermissionsRequestItem.create({
            ...item[side],
            subject: { object: { objectId: principalId, objectType: 'principal' } },
          }),
        );
        const response = yield* rpc.checkBulkPermissions(v1.CheckBulkPermissionsRequest.create({ consistency, items }));
        if (response.pairs.length !== items.length) {
          return yield* new ServicePermissionComparisonError({ reason: 'Incomplete native service permission batch' });
        }
        for (const [index, pair] of response.pairs.entries()) {
          if (
            pair.request === undefined ||
            v1.CheckBulkPermissionsRequestItem.toJsonString(pair.request) !==
              v1.CheckBulkPermissionsRequestItem.toJsonString(items[index]) ||
            pair.response.oneofKind !== 'item'
          ) {
            return yield* new ServicePermissionComparisonError({
              reason: 'Native service permission pairing or RPC error',
            });
          }
          const value = pair.response.item.permissionship;
          if (
            value !== v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION &&
            value !== v1.CheckPermissionResponse_Permissionship.NO_PERMISSION
          ) {
            return yield* new ServicePermissionComparisonError({
              reason: 'Conditional service permission cannot be compared',
            });
          }
          values.push(value === v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION);
        }
      }
      return values;
    });
    const before = yield* evaluate('before', beforeConsistency);
    const after = yield* evaluate('after', afterConsistency);
    const changes = cases.flatMap((item, index) =>
      before[index] === after[index]
        ? []
        : [
            {
              ...item,
              afterAllowed: after[index],
              beforeAllowed: before[index],
            },
          ],
    );
    return {
      checks: cases.length * 2,
      gains: changes.filter((change) => !change.beforeAllowed),
      losses: changes.filter((change) => change.beforeAllowed),
      newAllowed: after.filter(Boolean).length,
      oldAllowed: before.filter(Boolean).length,
    };
  },
);
