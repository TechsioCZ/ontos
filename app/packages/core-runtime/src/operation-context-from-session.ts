// @effect-diagnostics asyncFunction:off
import { and, eq } from 'drizzle-orm';
import { auth } from './auth/config.ts';
import { db } from './db/client.ts';
import { legalEntities, principalAuthBindings, principals, tenants } from './db/schema.ts';
import { listTenantModuleStates } from './module-state.ts';
import type { TenantModuleState } from './module-state.ts';

interface ResolvedOperationIdentity {
  readonly legalEntityId: string;
  readonly principalDisplayName: string;
  readonly principalId: string;
  readonly tenantId: string;
}

// oxlint-disable-next-line typescript/consistent-type-definitions
export type OperationContextAuthRequired = {
  readonly _tag: 'OperationContextAuthRequired';
  readonly message: string;
};

export type ResolveOperationContextFromSessionResult =
  | {
      readonly _tag: 'Success';
      readonly moduleStates: readonly TenantModuleState[];
      readonly operationContext: ResolvedOperationIdentity;
    }
  | {
      readonly _tag: 'Failure';
      readonly error: OperationContextAuthRequired;
    };

const authRequired = (): OperationContextAuthRequired => ({
  _tag: 'OperationContextAuthRequired',
  message: 'Authentication is required to create an operation context.',
});

const bindingRequired = (): OperationContextAuthRequired => ({
  _tag: 'OperationContextAuthRequired',
  message: 'Authenticated user is not bound to an active OntOS principal.',
});

export const resolveOperationContextFromSession = async ({
  headers,
}: {
  headers: Headers;
}): Promise<ResolveOperationContextFromSessionResult> => {
  const session = await auth.api.getSession({ headers }).catch(() => null);
  const userId = session?.user.id;

  if (session === null || userId === undefined) {
    return {
      _tag: 'Failure',
      error: authRequired(),
    };
  }

  const [binding] = await db
    .select({
      legalEntityId: legalEntities.legalEntityId,
      principalDisplayName: principals.displayName,
      principalId: principals.principalId,
      tenantId: tenants.tenantId,
    })
    .from(principalAuthBindings)
    .innerJoin(principals, eq(principalAuthBindings.principalId, principals.principalId))
    .innerJoin(tenants, eq(principalAuthBindings.tenantId, tenants.tenantId))
    .innerJoin(legalEntities, eq(legalEntities.tenantId, tenants.tenantId))
    .where(
      and(
        eq(principalAuthBindings.provider, 'better_auth'),
        eq(principalAuthBindings.subjectType, 'user'),
        eq(principalAuthBindings.providerSubjectId, userId),
        eq(principalAuthBindings.status, 'active'),
        eq(principals.status, 'active'),
        eq(tenants.status, 'active'),
        eq(legalEntities.status, 'active'),
      ),
    )
    .limit(1);

  if (binding === undefined) {
    return {
      _tag: 'Failure',
      error: bindingRequired(),
    };
  }

  const moduleStates = await listTenantModuleStates(binding.tenantId);

  return {
    _tag: 'Success',
    moduleStates,
    operationContext: {
      legalEntityId: binding.legalEntityId,
      principalDisplayName: binding.principalDisplayName,
      principalId: binding.principalId,
      tenantId: binding.tenantId,
    },
  };
};
