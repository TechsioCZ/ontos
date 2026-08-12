/* eslint-disable no-await-in-loop, node/no-process-env -- This explicit local-development command validates its process environment before any write. */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { v1 } from '@authzed/authzed-node';
import {
  ActionRuntimeLive,
  CorePersistenceLive,
  InstalledModuleCatalogService,
  buildInstalledModuleCatalog,
  changeTenantModuleStateAction,
  runAction,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
  toSpiceDbActionObjectId,
} from '@app/core-runtime';
import { config as loadDotenv } from 'dotenv';
import { Effect, Layer } from 'effect';
import { Pool } from 'pg';
import { deriveOntosModuleDeploymentContract } from '../../../scripts/generate-ontos-module-contract.mts';

interface LocalDevelopmentTargets {
  readonly databaseUrl: string;
  readonly nodeEnvironment?: string;
  readonly spiceDbEndpoint: string;
  readonly spiceDbInsecure: boolean;
}

interface DevelopmentPrincipal {
  readonly authBindingId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly tenantId: string;
}

interface LegalEntityRecord {
  readonly legalEntityId: string;
  readonly tenantId: string;
}

interface ModuleStateRecord {
  readonly state: null | string;
  readonly tenantId: string;
}

interface SpiceDbConfiguration {
  readonly endpoint: string;
  readonly insecureLocal: boolean;
  readonly preSharedKey: string;
}

const localHosts = new Set(['127.0.0.1', '::1', 'localhost']);

export const assertLocalDevelopmentTargets = (input: LocalDevelopmentTargets): void => {
  if (input.nodeEnvironment === 'production') {
    throw new Error('CRM development provisioning is disabled in production');
  }
  const database = new URL(input.databaseUrl);
  if (!localHosts.has(database.hostname)) {
    throw new Error('CRM development provisioning requires local PostgreSQL');
  }
  const spiceDb = new URL(`http://${input.spiceDbEndpoint}`);
  if (!input.spiceDbInsecure || !localHosts.has(spiceDb.hostname) || spiceDb.port.length === 0) {
    throw new Error('CRM development provisioning requires insecure localhost SpiceDB');
  }
};

const relationship = (
  resourceType: string,
  resourceId: string,
  relation: string,
  subjectType: string,
  subjectId: string,
) =>
  v1.Relationship.create({
    relation,
    resource: v1.ObjectReference.create({ objectId: resourceId, objectType: resourceType }),
    subject: v1.SubjectReference.create({
      object: v1.ObjectReference.create({ objectId: subjectId, objectType: subjectType }),
    }),
  });

const chunks = <Value,>(values: readonly Value[], size: number): readonly (readonly Value[])[] => {
  const result: Value[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
};

const provisionRelationships = async (
  principals: readonly DevelopmentPrincipal[],
  legalEntities: readonly LegalEntityRecord[],
  crmActionKeys: readonly string[],
  configuration: SpiceDbConfiguration,
): Promise<void> => {
  const client = v1.NewClient(
    configuration.preSharedKey,
    configuration.endpoint,
    configuration.insecureLocal
      ? v1.ClientSecurity.INSECURE_LOCALHOST_ALLOWED
      : v1.ClientSecurity.SECURE,
  );
  const actionKeys = ['core.modules.change-tenant-module-state', ...crmActionKeys];
  const legalEntitiesByTenant = new Map<string, LegalEntityRecord[]>();
  for (const legalEntity of legalEntities) {
    const current = legalEntitiesByTenant.get(legalEntity.tenantId) ?? [];
    current.push(legalEntity);
    legalEntitiesByTenant.set(legalEntity.tenantId, current);
  }
  const relationships = [
    ...actionKeys.map((actionKey) => {
      const actionId = toSpiceDbActionObjectId(actionKey);
      return relationship('action', actionId, 'restriction', 'action', actionId);
    }),
    ...principals.flatMap((principal) => {
      const principalRelationships = [
        relationship('tenant', principal.tenantId, 'member', 'principal', principal.principalId),
        ...actionKeys.map((actionKey) => {
          const actionId = toSpiceDbActionObjectId(actionKey);
          return relationship('action', actionId, 'executor', 'principal', principal.principalId);
        }),
      ];
      for (const legalEntity of legalEntitiesByTenant.get(principal.tenantId) ?? []) {
        const legalEntityObjectId = toLegalEntityAccessObjectId(
          principal.tenantId,
          legalEntity.legalEntityId,
        );
        const moduleObjectId = toModuleAccessObjectId(
          principal.tenantId,
          legalEntity.legalEntityId,
          'crm.core',
        );
        if (legalEntityObjectId === undefined || moduleObjectId === undefined) {
          throw new Error('CRM development authorization object ID could not be encoded');
        }
        principalRelationships.push(
          relationship('legal_entity', legalEntityObjectId, 'tenant', 'tenant', principal.tenantId),
          relationship(
            'legal_entity',
            legalEntityObjectId,
            'member',
            'principal',
            principal.principalId,
          ),
          relationship(
            'module_access',
            moduleObjectId,
            'legal_entity',
            'legal_entity',
            legalEntityObjectId,
          ),
          relationship(
            'module_access',
            moduleObjectId,
            'accessor',
            'principal',
            principal.principalId,
          ),
        );
      }
      return principalRelationships;
    }),
  ];
  const uniqueRelationships = [
    ...new Map(relationships.map((item) => [JSON.stringify(item), item])).values(),
  ];
  try {
    for (const batch of chunks(uniqueRelationships, 100)) {
      await client.promises.writeRelationships(
        v1.WriteRelationshipsRequest.create({
          updates: batch.map((item) =>
            v1.RelationshipUpdate.create({
              operation: v1.RelationshipUpdate_Operation.TOUCH,
              relationship: item,
            }),
          ),
        }),
      );
    }
  } finally {
    client.close();
  }
};

const loadSpiceDbConfiguration = (): SpiceDbConfiguration => {
  const endpoint = process.env['SPICEDB_ENDPOINT']?.trim();
  const preSharedKey = process.env['SPICEDB_PRESHARED_KEY']?.trim();
  const insecure = process.env['SPICEDB_INSECURE']?.trim().toLowerCase();
  if (endpoint === undefined || preSharedKey === undefined || insecure !== 'true') {
    throw new Error(
      'SPICEDB_ENDPOINT, SPICEDB_PRESHARED_KEY, and SPICEDB_INSECURE=true are required',
    );
  }
  return { endpoint, insecureLocal: true, preSharedKey };
};

const activateCrm = async (
  principals: readonly DevelopmentPrincipal[],
  states: readonly ModuleStateRecord[],
  contract: Awaited<ReturnType<typeof deriveOntosModuleDeploymentContract>>,
): Promise<number> => {
  const catalog = buildInstalledModuleCatalog([{ contract, expectedAppId: 'crm' }]);
  const runtimeLayer = ActionRuntimeLive.pipe(Layer.provide(CorePersistenceLive));
  const stateByTenant = new Map(states.map(({ state, tenantId }) => [tenantId, state]));
  let activated = 0;
  for (const principal of principals) {
    const state = stateByTenant.get(principal.tenantId) ?? null;
    if (state === 'active') {
      continue;
    }
    const idempotencyKey = randomUUID();
    await Effect.runPromise(
      runAction({
        payload: {
          ...(state === null ? {} : { expectedState: state }),
          moduleKey: 'crm.core',
          newState: 'active',
          reason: 'Explicit localhost CRM development provisioning',
        },
        principal: {
          authBindingId: principal.authBindingId,
          authContextRef: `better-auth-session:${principal.sessionId}`,
          authMethod: 'session',
          principalId: principal.principalId,
          tenantId: principal.tenantId,
        },
        registration: changeTenantModuleStateAction,
        transport: {
          correlationId: `crm-development-provisioning-${idempotencyKey}`,
          idempotencyKey,
          targetModuleKey: 'crm.core',
          targetResourceId: 'crm.core',
          targetResourceType: 'tenant-module-state',
        },
      }).pipe(
        Effect.provideService(InstalledModuleCatalogService, { load: Effect.succeed(catalog) }),
        Effect.provide(runtimeLayer),
        Effect.scoped,
      ),
    );
    stateByTenant.set(principal.tenantId, 'active');
    activated += 1;
  }
  return activated;
};

export const provisionCrmDevelopment = async (): Promise<{
  readonly activatedTenants: number;
  readonly legalEntities: number;
  readonly principals: number;
}> => {
  const applicationRoot = new URL('../../../', import.meta.url);
  const environmentPath = new URL('.env', applicationRoot);
  const loaded = loadDotenv({ path: environmentPath, quiet: true });
  if (loaded.error !== undefined) {
    throw loaded.error;
  }
  const databaseUrl = process.env['DATABASE_URL']?.trim();
  const databaseAdminUrl = process.env['DATABASE_ADMIN_URL']?.trim() ?? databaseUrl;
  if (databaseUrl === undefined || databaseAdminUrl === undefined) {
    throw new Error('DATABASE_URL and DATABASE_ADMIN_URL are required');
  }
  const spiceDb = loadSpiceDbConfiguration();
  assertLocalDevelopmentTargets({
    databaseUrl,
    nodeEnvironment: process.env['NODE_ENV'],
    spiceDbEndpoint: spiceDb.endpoint,
    spiceDbInsecure: spiceDb.insecureLocal,
  });
  assertLocalDevelopmentTargets({
    databaseUrl: databaseAdminUrl,
    nodeEnvironment: process.env['NODE_ENV'],
    spiceDbEndpoint: spiceDb.endpoint,
    spiceDbInsecure: spiceDb.insecureLocal,
  });

  const pool = new Pool({ connectionString: databaseAdminUrl });
  try {
    const principalResult = await pool.query<DevelopmentPrincipal>(`
      select distinct on (binding.tenant_id, binding.principal_id)
        binding.principal_auth_binding_id::text as "authBindingId",
        binding.principal_id::text as "principalId",
        session.id as "sessionId",
        binding.tenant_id::text as "tenantId"
      from auth.session as session
      inner join core.principal_auth_bindings as binding
        on binding.provider = 'better_auth'
        and binding.provider_subject_id = session.user_id
        and binding.subject_type = 'user'
        and binding.status = 'active'
        and binding.revoked_at is null
      inner join core.principals as principal
        on principal.tenant_id = binding.tenant_id
        and principal.principal_id = binding.principal_id
        and principal.status = 'active'
      inner join core.tenants as tenant
        on tenant.tenant_id = binding.tenant_id
        and tenant.status = 'active'
      where session.expires_at > now()
      order by binding.tenant_id, binding.principal_id, session.updated_at desc
    `);
    if (principalResult.rows.length === 0) {
      throw new Error('No active local Better Auth session has an active principal binding');
    }
    const tenantIds = [...new Set(principalResult.rows.map(({ tenantId }) => tenantId))];
    const legalEntityResult = await pool.query<LegalEntityRecord>(
      `select legal_entity_id::text as "legalEntityId", tenant_id::text as "tenantId"
       from core.legal_entities
       where status = 'active' and tenant_id = any($1::uuid[])
       order by tenant_id, legal_entity_id`,
      [tenantIds],
    );
    const stateResult = await pool.query<ModuleStateRecord>(
      `select tenant.tenant_id::text as "tenantId", state.state
       from unnest($1::uuid[]) as tenant(tenant_id)
       left join core.tenant_module_states as state
         on state.tenant_id = tenant.tenant_id and state.module_key = 'crm.core'
       order by tenant.tenant_id`,
      [tenantIds],
    );
    const contract = await deriveOntosModuleDeploymentContract({ vertical: 'crm' });
    await provisionRelationships(
      principalResult.rows,
      legalEntityResult.rows,
      contract.manifest.publicSurface.actions.map(({ actionKey }) => actionKey),
      spiceDb,
    );
    const activatedTenants = await activateCrm(principalResult.rows, stateResult.rows, contract);
    return {
      activatedTenants,
      legalEntities: legalEntityResult.rows.length,
      principals: principalResult.rows.length,
    };
  } finally {
    await pool.end();
  }
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { activatedTenants, legalEntities, principals } = await provisionCrmDevelopment();
    console.log(
      `CRM development access provisioned for ${principals} principal(s), ${legalEntities} legal entity/entities, and ${activatedTenants} newly activated tenant(s). Select a legal entity in the Shell to open CRM.`,
    );
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : 'CRM development provisioning failed');
    process.exitCode = 1;
  }
}
