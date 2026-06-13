// @effect-diagnostics asyncFunction:off strictBooleanExpressions:off
import { coreDb } from './db/client.ts';
import type { CoreDb } from './db/client.ts';
import {
  findDefaultLegalEntity,
  findPrincipalBinding,
  findTenantById,
  findTenantBySlug,
  listTenantModuleStates,
} from './db/queries.ts';
import type { RuntimeContext, RuntimeContextInput, SerializableFailureCode } from './types.ts';

export type RuntimeContextResolution =
  | {
      ok: true;
      context: RuntimeContext;
    }
  | {
      ok: false;
      code: Extract<
        SerializableFailureCode,
        'context_missing' | 'tenant_not_active' | 'principal_not_active'
      >;
      message: string;
    };

export const resolveRuntimeContextResult = async (
  input: RuntimeContextInput,
  db: CoreDb = coreDb,
): Promise<RuntimeContextResolution> => {
  const requestedTenant =
    input.tenantSlug === undefined ? null : await findTenantBySlug(db, input.tenantSlug);

  if (input.tenantSlug !== undefined && requestedTenant === null) {
    return {
      code: 'context_missing',
      message: `Tenant '${input.tenantSlug}' was not found.`,
      ok: false,
    };
  }

  const principal = await findPrincipalBinding(
    db,
    requestedTenant === null
      ? {
          providerSubjectId: input.providerSubjectId,
        }
      : {
          providerSubjectId: input.providerSubjectId,
          tenantId: requestedTenant.tenantId,
        },
  );

  if (principal === null) {
    return {
      code: 'context_missing',
      message: 'BetterAuth subject did not resolve to exactly one active OntOS principal binding.',
      ok: false,
    };
  }

  if (principal.status !== 'active') {
    return {
      code: 'principal_not_active',
      message: 'Resolved OntOS principal is not active.',
      ok: false,
    };
  }

  const tenant = requestedTenant ?? (await findTenantById(db, principal.tenantId));

  if (tenant === null) {
    return {
      code: 'context_missing',
      message: 'Resolved principal points at a tenant that does not exist.',
      ok: false,
    };
  }

  if (tenant.status !== 'active') {
    return {
      code: 'tenant_not_active',
      message: `Tenant '${tenant.slug}' is ${tenant.status}.`,
      ok: false,
    };
  }

  const legalEntity = await findDefaultLegalEntity(db, tenant.tenantId);

  if (legalEntity === null) {
    return {
      code: 'context_missing',
      message: `Tenant '${tenant.slug}' has no legal entity seed row.`,
      ok: false,
    };
  }

  const moduleStates = await listTenantModuleStates(db, tenant.tenantId);

  return {
    context: {
      auth: {
        contextRef: input.authContextRef ?? `better-auth:user:${input.providerSubjectId}`,
        method: input.authMethod ?? 'session',
      },
      legalEntity,
      moduleStates,
      principal,
      tenant,
    },
    ok: true,
  };
};
