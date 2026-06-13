// @effect-diagnostics asyncFunction:off strictBooleanExpressions:off
import { and, eq } from 'drizzle-orm';
import type {
  AuthSubjectType,
  PrincipalKind,
  PrincipalStatus,
  RuntimeLegalEntity,
  RuntimeModuleState,
  RuntimePrincipal,
  RuntimeTenant,
  TenantModuleState,
  TenantStatus,
} from '../types.ts';
import type { CoreDb } from './client.ts';
import {
  coreLegalEntities,
  corePrincipalAuthBindings,
  corePrincipals,
  coreTenantModuleStates,
  coreTenants,
} from './schema.ts';

export const findTenantBySlug = async (db: CoreDb, slug: string): Promise<RuntimeTenant | null> => {
  const rows = await db.select().from(coreTenants).where(eq(coreTenants.slug, slug)).limit(1);
  const [tenant] = rows;

  if (tenant === undefined) {
    return null;
  }

  return {
    defaultLocale: tenant.defaultLocale,
    name: tenant.name,
    slug: tenant.slug,
    status: tenant.status as TenantStatus,
    tenantId: tenant.tenantId,
  };
};

export const findTenantById = async (
  db: CoreDb,
  tenantId: string,
): Promise<RuntimeTenant | null> => {
  const rows = await db
    .select()
    .from(coreTenants)
    .where(eq(coreTenants.tenantId, tenantId))
    .limit(1);
  const [tenant] = rows;

  if (tenant === undefined) {
    return null;
  }

  return {
    defaultLocale: tenant.defaultLocale,
    name: tenant.name,
    slug: tenant.slug,
    status: tenant.status as TenantStatus,
    tenantId: tenant.tenantId,
  };
};

export const findDefaultLegalEntity = async (
  db: CoreDb,
  tenantId: string,
): Promise<RuntimeLegalEntity | null> => {
  const rows = await db
    .select()
    .from(coreLegalEntities)
    .where(eq(coreLegalEntities.tenantId, tenantId))
    .limit(1);
  const [legalEntity] = rows;

  if (legalEntity === undefined) {
    return null;
  }

  return {
    legalEntityId: legalEntity.legalEntityId,
    legalName: legalEntity.legalName,
    registrationCountry: legalEntity.registrationCountry,
    registrationNumber: legalEntity.registrationNumber,
    status: legalEntity.status,
    tenantId: legalEntity.tenantId,
    vatId: legalEntity.vatId,
  };
};

export const findPrincipalBinding = async (
  db: CoreDb,
  input: {
    providerSubjectId: string;
    tenantId?: string;
    subjectType?: AuthSubjectType;
  },
): Promise<RuntimePrincipal | null> => {
  const subjectType = input.subjectType ?? 'user';
  const filters = [
    eq(corePrincipalAuthBindings.provider, 'better_auth'),
    eq(corePrincipalAuthBindings.subjectType, subjectType),
    eq(corePrincipalAuthBindings.providerSubjectId, input.providerSubjectId),
    eq(corePrincipalAuthBindings.status, 'active'),
  ];

  if (input.tenantId !== undefined) {
    filters.push(eq(corePrincipalAuthBindings.tenantId, input.tenantId));
  }

  const rows = await db
    .select({
      bindingId: corePrincipalAuthBindings.principalAuthBindingId,
      displayName: corePrincipals.displayName,
      kind: corePrincipals.kind,
      principalId: corePrincipals.principalId,
      provider: corePrincipalAuthBindings.provider,
      providerSubjectId: corePrincipalAuthBindings.providerSubjectId,
      status: corePrincipals.status,
      subjectType: corePrincipalAuthBindings.subjectType,
      tenantId: corePrincipals.tenantId,
    })
    .from(corePrincipalAuthBindings)
    .innerJoin(
      corePrincipals,
      eq(corePrincipalAuthBindings.principalId, corePrincipals.principalId),
    )
    .where(and(...filters))
    .limit(2);

  if (rows.length !== 1) {
    return null;
  }

  const [row] = rows;

  if (row === undefined) {
    return null;
  }

  return {
    authBindingId: row.bindingId,
    displayName: row.displayName,
    kind: row.kind as PrincipalKind,
    principalId: row.principalId,
    provider: 'better_auth',
    providerSubjectId: row.providerSubjectId,
    status: row.status as PrincipalStatus,
    subjectType: row.subjectType as AuthSubjectType,
    tenantId: row.tenantId,
  };
};

export const listTenantModuleStates = async (
  db: CoreDb,
  tenantId: string,
): Promise<RuntimeModuleState[]> => {
  const rows = await db
    .select()
    .from(coreTenantModuleStates)
    .where(eq(coreTenantModuleStates.tenantId, tenantId));

  return rows.map((row) => ({
    moduleKey: row.moduleKey,
    state: row.state as TenantModuleState,
    tenantId: row.tenantId,
  }));
};
