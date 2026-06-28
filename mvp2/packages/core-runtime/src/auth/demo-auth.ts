// @effect-diagnostics asyncFunction:off globalDate:off
import { eq } from 'drizzle-orm';
import { installedModuleKeys } from '@mvp2/shared-contracts';
import {
  legalEntities,
  principalAuthBindings,
  principals,
  tenantModuleStates,
  tenants,
} from '../db/schema.ts';
import { db } from '../db/client.ts';
import { checkModuleStateAdminCapability, listTenantModuleStates } from '../module-state.ts';
import { auth } from './config.ts';

export type DemoUserKey = 'admin' | 'user';

const demoTenant = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'OntOS Demo Tenant',
  slug: 'ontos-demo',
};

const demoLegalEntity = {
  id: '22222222-2222-4222-8222-222222222222',
  legalName: 'OntOS Demo s.r.o.',
  registrationCountry: 'CZ',
  registrationNumber: '00000001',
};

const demoUsers: Record<
  DemoUserKey,
  { email: string; name: string; password: string; principalId: string }
> = {
  admin: {
    email: 'admin@ontos.local',
    name: 'Admin',
    password: 'local-admin-password',
    principalId: '33333333-3333-4333-8333-333333333333',
  },
  user: {
    email: 'user@ontos.local',
    name: 'User',
    password: 'local-user-password',
    principalId: '44444444-4444-4444-8444-444444444444',
  },
};

const now = () => new Date();

const ensureCoreContext = async (userId: string, demoUserKey: DemoUserKey) => {
  const demoUser = demoUsers[demoUserKey];

  await db
    .insert(tenants)
    .values({
      createdAt: now(),
      defaultLocale: 'en',
      name: demoTenant.name,
      slug: demoTenant.slug,
      status: 'active',
      tenantId: demoTenant.id,
      updatedAt: now(),
    })
    .onConflictDoNothing();

  await db
    .insert(legalEntities)
    .values({
      createdAt: now(),
      legalEntityId: demoLegalEntity.id,
      legalName: demoLegalEntity.legalName,
      registrationCountry: demoLegalEntity.registrationCountry,
      registrationNumber: demoLegalEntity.registrationNumber,
      status: 'active',
      tenantId: demoTenant.id,
      updatedAt: now(),
    })
    .onConflictDoNothing();

  await db
    .insert(principals)
    .values({
      createdAt: now(),
      displayName: demoUser.name,
      kind: 'human',
      principalId: demoUser.principalId,
      status: 'active',
      tenantId: demoTenant.id,
    })
    .onConflictDoNothing();

  await db
    .insert(principalAuthBindings)
    .values({
      createdAt: now(),
      principalAuthBindingId:
        demoUserKey === 'admin'
          ? '55555555-5555-4555-8555-555555555555'
          : '66666666-6666-4666-8666-666666666666',
      principalId: demoUser.principalId,
      provider: 'better_auth',
      providerSubjectId: userId,
      status: 'active',
      subjectType: 'user',
      tenantId: demoTenant.id,
      updatedAt: now(),
    })
    .onConflictDoNothing();

  await db
    .insert(tenantModuleStates)
    .values(
      installedModuleKeys.map((moduleKey) => ({
        createdAt: now(),
        moduleKey,
        state: 'active',
        tenantId: demoTenant.id,
        updatedAt: now(),
      })),
    )
    .onConflictDoNothing();
};

const ensureBetterAuthUser = async (demoUserKey: DemoUserKey, headers: Headers) => {
  const demoUser = demoUsers[demoUserKey];

  try {
    const signIn = await auth.api.signInEmail({
      body: {
        email: demoUser.email,
        password: demoUser.password,
      },
      headers,
      asResponse: true,
    });

    if (signIn.ok) {
      return signIn;
    }
  } catch {
    // First local login signs the demo user up below.
  }

  await auth.api.signUpEmail({
    body: {
      email: demoUser.email,
      name: demoUser.name,
      password: demoUser.password,
    },
    headers,
  });

  return auth.api.signInEmail({
    body: {
      email: demoUser.email,
      password: demoUser.password,
    },
    headers,
    asResponse: true,
  });
};

const responseCookies = (response: Response) => {
  const cookie = response.headers.get('set-cookie');
  return cookie === null ? [] : [cookie];
};

interface AuthUser {
  email: string;
  id: string;
  name: string;
}

const userFromSignInBody = (body: unknown): AuthUser | undefined =>
  typeof body === 'object' &&
  body !== null &&
  'user' in body &&
  typeof body.user === 'object' &&
  body.user !== null &&
  'id' in body.user &&
  typeof body.user.id === 'string' &&
  'email' in body.user &&
  typeof body.user.email === 'string' &&
  'name' in body.user &&
  typeof body.user.name === 'string'
    ? {
        email: body.user.email,
        id: body.user.id,
        name: body.user.name,
      }
    : undefined;

const getAuthContextForUser = async (user: AuthUser) => {
  const [binding] = await db
    .select({
      authBindingId: principalAuthBindings.principalAuthBindingId,
      legalEntityId: legalEntities.legalEntityId,
      legalEntityName: legalEntities.legalName,
      principalDisplayName: principals.displayName,
      principalId: principals.principalId,
      tenantId: tenants.tenantId,
      tenantName: tenants.name,
    })
    .from(principalAuthBindings)
    .innerJoin(principals, eq(principalAuthBindings.principalId, principals.principalId))
    .innerJoin(tenants, eq(principalAuthBindings.tenantId, tenants.tenantId))
    .innerJoin(legalEntities, eq(legalEntities.tenantId, tenants.tenantId))
    .where(eq(principalAuthBindings.providerSubjectId, user.id))
    .limit(1);

  if (binding === undefined) {
    return { context: null };
  }

  const moduleStates = await listTenantModuleStates(binding.tenantId);
  const [canView, canChange] = await Promise.all([
    checkModuleStateAdminCapability({
      permission: 'view',
      principalId: binding.principalId,
      tenantId: binding.tenantId,
    }),
    checkModuleStateAdminCapability({
      permission: 'change',
      principalId: binding.principalId,
      tenantId: binding.tenantId,
    }),
  ]);

  return {
    context: {
      authBindingId: binding.authBindingId,
      legalEntity: {
        id: binding.legalEntityId,
        name: binding.legalEntityName,
      },
      moduleStateAdmin: {
        canChange,
        canView,
      },
      moduleStates,
      principal: {
        displayName: binding.principalDisplayName,
        id: binding.principalId,
      },
      tenant: {
        id: binding.tenantId,
        name: binding.tenantName,
      },
      user,
    },
  };
};

export const signInDemoUser = async ({
  demoUserKey,
  headers,
}: {
  demoUserKey: DemoUserKey;
  headers: Headers;
}) => {
  const response = await ensureBetterAuthUser(demoUserKey, headers);
  const user = userFromSignInBody(await response.clone().json());

  if (user !== undefined) {
    await ensureCoreContext(user.id, demoUserKey);
  }

  return {
    body: user === undefined ? { context: null } : await getAuthContextForUser(user),
    setCookieHeaders: responseCookies(response),
  };
};

export const signOutDemoUser = async ({ headers }: { headers: Headers }) => {
  const response = await auth.api.signOut({
    headers,
    asResponse: true,
  });

  return {
    body: { context: null },
    setCookieHeaders: responseCookies(response),
  };
};

export const getCurrentAuthContext = async ({ headers }: { headers: Headers }) => {
  const session = await auth.api.getSession({ headers });
  const userId = session?.user.id;

  if (session === null || userId === undefined) {
    return { context: null };
  }

  return getAuthContextForUser({
    email: session.user.email,
    id: userId,
    name: session.user.name,
  });
};
