#!/usr/bin/env node
/**
 * N1-only stage policy. Plan reads public contracts and writes an owner-only local plan.
 * Apply requires that exact plan and fingerprint before the native service installer or any grant write.
 * Provider credentials come from the operator environment, never SSH, .env, or this access file.
 */
import { createHash } from 'node:crypto';

import {
  ownerResourceModuleContainment,
  toContextPermissionAccessObjectId,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
  toResourceAccessObjectId,
} from '@app/core-runtime';
import { reconcileStageServicePrincipals } from '@app/core-runtime/install/stage-context-bootstrap';
import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import {
  Array as EffectArray,
  Config,
  ConfigProvider,
  Console,
  Effect,
  Exit,
  FileSystem,
  Option,
  Order,
  Redacted,
  Schema,
} from 'effect';
import { Command, Flag } from 'effect/cli';
import { FetchHttpClient, HttpClient } from 'effect/http';

import {
  buildActionAuthorizationRelationships,
  deriveScopedActionAuthorization,
} from '../../packages/core-runtime/src/install/action-authorization-provisioning.ts';
import { bootstrapRelationshipsFromNative } from '../../packages/core-runtime/src/install/context-bootstrap-shared.ts';
import {
  ONTOS_MODULE_CONTRACT_MAX_BYTES,
  OntosDeploymentAppIdSchema,
  OntosModuleDeploymentContractSchema,
} from '../../packages/core-runtime/src/modules/manifest.ts';
import type { OntosActionContract } from '../../packages/core-runtime/src/modules/manifest.ts';
import { coreActionCatalog } from '../../packages/core-runtime/src/modules/actions/catalog.ts';
import { parseSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../packages/core-runtime/src/permissions/schema.ts';
import { toScopedRoleObjectId } from '../../packages/core-runtime/src/permissions/scoped-role.ts';
import { toSpiceDbActionObjectId } from '../../packages/core-runtime/src/permissions/service.ts';
import { openSpiceDbGrpcRpc } from '../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import type { SpiceDbRpc } from '../../packages/core-runtime/src/permissions/spicedb-rpc.ts';
import { ProcessDatabasePoolsLive } from '../zerops/process-database-pools.mts';
import {
  akrosPlaygroundAccounts,
  akrosPlaygroundLegalEntityId,
  akrosPlaygroundServices,
  akrosPlaygroundTenantId,
} from './akros-playground-policy.mts';
import { akrosDemoLegalEntityId, demoTenantId } from './fixture-ids.mts';
import type { DemoAction, DemoRelationship, DemoRole } from './permissions.mts';
import {
  akrosStorefrontPrincipal,
  companyCoreModuleStructure,
  companyHumanAccounts,
  demoHumanAccounts,
  principalRelationships,
  roleRelationship,
  scopedDemoActionRelationships,
} from './permissions.mts';
import { reconcileServiceGrants } from './reconcile-stage-service-grants.mts';

export const N1_TENANT_ID = 'cfcd7ae8-90b9-4c49-927c-b5d66224a618';
export const N1_LEGAL_ENTITY_ID = 'd7ad363a-ddb0-46c6-bb11-8d9362281297';
export const N1_STAGE_ORIGIN = 'https://ontos-stage.web-revolution.cz';
const merchandise = 'demo.merchandise';
const markets = 'commerce.market-catalog';
const registry = 'commerce.storefront-registry';
const workTasks = 'work.tasks';
const managedKeyAction = 'core.identity.bind-managed-api-key';
const storefrontName = 'n1-storefront';
const marketAuthorityName = 'n1-market-authority';
export const n1ManifestSources = [
  { appId: 'merchandise', moduleId: merchandise },
  { appId: 'commerce-market-catalog', moduleId: markets },
  { appId: 'storefront-registry', moduleId: registry },
  { appId: 'work-tasks', moduleId: workTasks },
] as const;
const modes = ['plan', 'apply', 'verify'] as const;
type Mode = (typeof modes)[number];
const uuid = Schema.String.check(Schema.isUUID());
const PrincipalIdSchema = uuid.pipe(Schema.brand('PrincipalId'));
const ObjectIdSchema = Schema.String.pipe(Schema.brand('ObjectId'));

export class N1StageGrantError extends Schema.TaggedError<N1StageGrantError>()('N1StageGrantError', {
  reason: Schema.String,
}) {}
const fail = (reason: string) => new N1StageGrantError({ reason });
export const n1PlanFingerprint = (text: string) => createHash('sha256').update(text).digest('hex');

/** Deliberately projects away passwords and every unrelated access-file field. */
export const N1AccessSchema = Schema.Struct({
  accounts: Schema.Array(
    Schema.Struct({
      displayName: Schema.Trim.check(Schema.isNonEmpty()),
      email: Schema.Literals(['admin@n1.ontos.demo', 'catalog@n1.ontos.demo']),
      principalId: Schema.toEncoded(PrincipalIdSchema),
    }),
  ).check(Schema.isMinLength(2), Schema.isMaxLength(2)),
  legalEntityId: Schema.Literal(N1_LEGAL_ENTITY_ID),
  modules: Schema.Struct({
    [markets]: uuid,
    [merchandise]: uuid,
    [registry]: uuid,
  }),
  schemaVersion: Schema.Literal(1),
  services: Schema.Struct({ 'market-authority': uuid, storefront: uuid }),
  shellUrl: Schema.Literal(N1_STAGE_ORIGIN),
  slug: Schema.Literal('n1-demo-20261103'),
  tenantId: Schema.Literal(N1_TENANT_ID),
});
export type N1Access = typeof N1AccessSchema.Type;

const oldPrincipals = EffectArray.sort(
  [
    ...new Set([
      ...akrosPlaygroundAccounts.map(({ principalId }) => principalId),
      ...akrosPlaygroundServices.map(({ principalId }) => principalId),
      ...demoHumanAccounts.map(({ principalId }) => principalId),
      ...companyHumanAccounts
        .filter(({ legalEntityId }) => legalEntityId === akrosDemoLegalEntityId)
        .map(({ principalId }) => principalId),
      akrosStorefrontPrincipal.principalId,
    ]),
  ],
  Order.String,
);

export const decodeN1Access = (source: string) =>
  Schema.decodeEffect(Schema.fromJsonString(N1AccessSchema))(source).pipe(
    Effect.mapError(() => fail('The N1 access file has an invalid target or identity shape; values withheld')),
    Effect.flatMap((access) => {
      const ids = [...access.accounts.map(({ principalId }) => principalId), ...Object.values(access.services)];
      return new Set(ids).size !== 4 ||
        new Set(access.accounts.map(({ email }) => email)).size !== 2 ||
        ids.some((id) => oldPrincipals.includes(id) || id === N1_TENANT_ID || id === N1_LEGAL_ENTITY_ID) ||
        new Set(Object.values(access.modules)).size !== 3
        ? Effect.fail(fail('N1 identities must be distinct, new, and contain both authorized accounts'))
        : Effect.succeed({
            ...access,
            accounts: EffectArray.sortWith(access.accounts, ({ email }) => email, Order.String),
          });
    }),
  );

export interface N1ContractDocument {
  readonly appId: string;
  readonly source: string;
}

const publicActionDescriptor = (moduleId: string, action: OntosActionContract) =>
  Effect.gen(function* publicAction() {
    const { entrypoint } = action;
    if (
      action.owningModuleId !== moduleId ||
      entrypoint.moduleKey !== moduleId ||
      entrypoint.entrypointKey !== action.actionKey ||
      entrypoint.scope !== 'tenant' ||
      entrypoint.role !== 'action' ||
      entrypoint.access !== 'write' ||
      entrypoint.authorization.kind !== 'action_execution'
    ) {
      return yield* fail('An N1 public Action does not match its owning contract');
    }
    return {
      actionKey: action.actionKey,
      legalEntityScope: action.legalEntityScope,
      owningModuleKey: action.owningModuleId,
      provisioning: entrypoint.authorization.provisioning,
    };
  });

/** A bounded public-contract slice, not an invented active Application Composition or global seal. */
export const decodeN1Contracts = (documents: readonly N1ContractDocument[]) =>
  Effect.gen(function* decodeContracts() {
    if (
      documents.length !== n1ManifestSources.length ||
      new Set(documents.map(({ appId }) => appId)).size !== n1ManifestSources.length
    ) {
      return yield* fail('Exactly the three live N1 public contracts are required');
    }
    const actions: DemoAction[] = [];
    for (const descriptor of coreActionCatalog) {
      if (descriptor.entrypoint.authorization.kind !== 'action_execution') {
        return yield* fail('Core Action classification is invalid');
      }
      actions.push({
        actionKey: descriptor.actionKey,
        legalEntityScope: descriptor.legalEntityScope,
        owningModuleKey: descriptor.owningModuleKey,
        provisioning: descriptor.entrypoint.authorization.provisioning,
      });
    }
    const contracts: { appId: string; buildMarker: string; sha256: string }[] = [];
    for (const expected of n1ManifestSources) {
      const document = documents.find(({ appId }) => appId === expected.appId);
      if (document === undefined || Buffer.byteLength(document.source, 'utf-8') > ONTOS_MODULE_CONTRACT_MAX_BYTES) {
        return yield* fail('An N1 public contract is missing or exceeds its byte budget');
      }
      const contract = yield* Schema.decodeEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema), {
        onExcessProperty: 'error',
      })(document.source).pipe(Effect.mapError(() => fail('An N1 public contract failed public-schema decoding')));
      if (
        contract.deployment.appId !== expected.appId ||
        contract.manifest.module.id !== expected.moduleId ||
        contract.manifest.publicSurface.actions.length === 0
      ) {
        return yield* fail('An N1 public contract has the wrong owner or no Actions');
      }
      for (const action of contract.manifest.publicSurface.actions) {
        actions.push(yield* publicActionDescriptor(expected.moduleId, action));
      }
      contracts.push({
        appId: expected.appId,
        buildMarker: contract.deployment.buildMarker,
        sha256: n1PlanFingerprint(document.source),
      });
    }
    if (
      new Set(actions.map(({ actionKey }) => actionKey)).size !== actions.length ||
      !actions.some(({ actionKey }) => actionKey === 'demo.merchandise.apply-command') ||
      !actions.some(({ actionKey }) => actionKey === managedKeyAction)
    ) {
      return yield* fail('The N1 Action slice is incomplete or contains duplicate Action keys');
    }
    return { actions: EffectArray.sortWith(actions, ({ actionKey }) => actionKey, Order.String), contracts };
  });

export const loadN1Contracts = Effect.gen(function* liveContracts() {
  const client = yield* HttpClient.HttpClient;
  return yield* Effect.forEach(
    n1ManifestSources,
    ({ appId }) =>
      client.get(`${N1_STAGE_ORIGIN}/_m/${appId}/.well-known/ontos-module-manifest.json`).pipe(
        Effect.flatMap(
          Effect.fnUntraced(function* readContract(response) {
            if (response.status !== 200) {
              return yield* fail('A live N1 public contract returned a non-200 response');
            }
            return yield* response.text;
          }),
        ),
        Effect.map((source) => ({ appId, source })),
        Effect.timeout('20 seconds'),
        Effect.mapError(() => fail('A live N1 public contract could not be read')),
      ),
    { concurrency: 3 },
  );
});

const companyObject = (tenantId = N1_TENANT_ID, legalEntityId = N1_LEGAL_ENTITY_ID) => ({
  objectId: toLegalEntityAccessObjectId(tenantId, legalEntityId) ?? '',
  objectType: 'legal_entity',
});
const moduleObject = (moduleId: string) => ({
  objectId: toModuleAccessObjectId(N1_TENANT_ID, N1_LEGAL_ENTITY_ID, moduleId) ?? '',
  objectType: 'module_access',
});
const actionObject = (action: DemoAction, legalEntityId: string | null = N1_LEGAL_ENTITY_ID) => {
  const scope =
    action.legalEntityScope === 'forbidden' || legalEntityId === null
      ? { actionKey: action.actionKey, tenantId: N1_TENANT_ID }
      : { actionKey: action.actionKey, legalEntityId, tenantId: N1_TENANT_ID };
  return { objectId: toSpiceDbActionObjectId(scope), objectType: 'action' };
};
const rootResource = {
  moduleId: markets,
  resourceId: N1_LEGAL_ENTITY_ID,
  resourceType: 'commerce.market-catalog.market-catalog-root',
};
const storefrontResource = {
  moduleId: registry,
  resourceId: storefrontName,
  resourceType: 'commerce.storefront-registry.storefront-application',
};
const resourceObject = (resource: typeof rootResource) => ({
  objectId: toResourceAccessObjectId(N1_TENANT_ID, N1_LEGAL_ENTITY_ID, resource) ?? '',
  objectType: 'resource',
});
export const n1ServiceDefinitions = (access: N1Access) => [
  {
    displayName: storefrontName,
    legalEntityId: N1_LEGAL_ENTITY_ID,
    principalId: access.services.storefront,
    tenantId: N1_TENANT_ID,
  },
  {
    displayName: marketAuthorityName,
    legalEntityId: N1_LEGAL_ENTITY_ID,
    principalId: access.services['market-authority'],
    tenantId: N1_TENANT_ID,
  },
];

/** Company administrator of N1 only: company roles and Core module reach, no tenant-wide superadmin. */
const administratorRole: DemoRole = {
  label: 'N1 company administration',
  modules: { [markets]: 'write', [merchandise]: 'write', [registry]: 'write', [workTasks]: 'write' },
};
/**
 * The storefront service runs exactly two Actions: the merchandise apply-command (guest quote and order; the command
 * guard admits only PlaceStorefrontOrder) and the work-tasks apply-command (the contact inquiry's CreateTask).
 *
 * Coupling in the role model: a non-restricted `write` module gets both `<module>.read_all` and `<module>.write_all`
 * (roleContextPermissions), and `read_all` is also what the module-wide reads use. Restricting the module drops both.
 * The handlers then need `write_all` for their write gate (merchandise persistence, work-tasks CreateTask), so the
 * role grants exactly that context permission explicitly. Read access stays the module accessor, and each module
 * keeps only the one listed executor.
 */
const storefrontActionKeys = {
  [merchandise]: ['demo.merchandise.apply-command'],
  [workTasks]: ['work.tasks.apply-command'],
} as const;
const storefrontWriteAllPermissions = {
  [merchandise]: ['demo.merchandise.write_all'],
  [workTasks]: ['work.tasks.write_all'],
} as const;
/** Catalogue manager: writes products and Markets only. Never an administrator of people or roles. */
const catalogueRole: DemoRole = {
  label: 'N1 catalogue management',
  modules: { [markets]: 'write', [merchandise]: 'write' },
};
const administratorEmail = 'admin@n1.ontos.demo';
const companyRoleObject = (roleKey: string) =>
  toScopedRoleObjectId({ legalEntityId: N1_LEGAL_ENTITY_ID, roleKey, tenantId: N1_TENANT_ID });
const storefrontRole: DemoRole = {
  actionKeys: storefrontActionKeys,
  contextPermissions: storefrontWriteAllPermissions,
  label: 'N1 storefront: public catalog, Market resolution, guest order and inquiry Actions',
  modules: { [markets]: 'read', [merchandise]: 'write', [workTasks]: 'write' },
  restrictedModules: [merchandise, workTasks],
};
const authorityRole: DemoRole = {
  label: 'N1 Market cross-owner validation',
  modules: { [markets]: 'read', [registry]: 'read' },
};

/** Identity admission stays with the native installers; service roles cannot open the staff Shell. */
const policyOnly = (row: DemoRelationship) =>
  !(row.resourceType === 'tenant' && ['member', 'company_member'].includes(row.relation)) &&
  !(row.resourceType === 'legal_entity' && row.relation === 'member');
const asNative = (row: DemoRelationship) =>
  v1.Relationship.create({
    relation: row.relation,
    resource: { objectId: row.resourceId, objectType: row.resourceType },
    subject: {
      object: { objectId: row.subjectId, objectType: row.subjectType },
      optionalRelation: row.subjectRelation ?? '',
    },
  });

export const n1GrantRelationships = (access: N1Access, actions: readonly DemoAction[]) =>
  Effect.gen(function* boundedRelationships() {
    const containment: DemoRelationship[] = [];
    for (const resource of [rootResource, storefrontResource]) {
      const edge = ownerResourceModuleContainment(N1_TENANT_ID, N1_LEGAL_ENTITY_ID, resource);
      if (edge === undefined) {
        return yield* fail('Invalid N1 owner Resource containment');
      }
      containment.push({
        relation: edge.relation,
        resourceId: edge.resource.objectId,
        resourceType: edge.resource.objectType,
        subjectId: edge.container.objectId,
        subjectType: edge.container.objectType,
      });
    }
    return yield* Effect.try({
      catch: () => fail('The bounded N1 role policy could not be derived'),
      try: () => {
        const moduleKeys = [...new Set(actions.map(({ owningModuleKey }) => owningModuleKey))];
        const scopes = [
          { moduleKeys, tenantId: N1_TENANT_ID },
          { legalEntityId: N1_LEGAL_ENTITY_ID, moduleKeys, tenantId: N1_TENANT_ID },
        ];
        const rows: DemoRelationship[] = [
          ...containment,
          ...bootstrapRelationshipsFromNative(
            buildActionAuthorizationRelationships(deriveScopedActionAuthorization(actions, scopes)),
          ),
        ];
        const managed = actions.filter(({ actionKey }) => actionKey === managedKeyAction);
        for (const { email, principalId } of access.accounts) {
          if (email !== administratorEmail) {
            rows.push(
              ...principalRelationships(
                principalId,
                catalogueRole,
                actions,
                N1_LEGAL_ENTITY_ID,
                N1_TENANT_ID,
                'n1-catalogue',
              ),
            );
            continue;
          }
          rows.push(
            ...principalRelationships(
              principalId,
              administratorRole,
              actions,
              N1_LEGAL_ENTITY_ID,
              N1_TENANT_ID,
              'n1-admin',
            ),
            // Do not use DemoRole.companyRole: that helper also installs unrelated Workforce permissions.
            ...principalRelationships(
              principalId,
              { label: 'N1 company admin', modules: {} },
              [],
              N1_LEGAL_ENTITY_ID,
              N1_TENANT_ID,
              'admin',
            ),
            roleRelationship('legal_entity', companyObject().objectId, 'admin', companyRoleObject('admin')),
            // Core modules (people, roles) reach the company only through this edge; see companyCoreModuleStructure.
            ...companyCoreModuleStructure(N1_TENANT_ID, N1_LEGAL_ENTITY_ID),
            ...managed.flatMap((action) =>
              scopedDemoActionRelationships(principalId, action, N1_LEGAL_ENTITY_ID, N1_TENANT_ID, 'n1-admin'),
            ),
          );
        }
        const services = [
          {
            principalId: access.services.storefront,
            readers: [markets],
            role: storefrontRole,
            roleKey: storefrontName,
          },
          {
            principalId: access.services['market-authority'],
            readers: [markets, registry],
            role: authorityRole,
            roleKey: marketAuthorityName,
          },
        ];
        for (const { principalId, readers, role, roleKey } of services) {
          rows.push(
            ...principalRelationships(principalId, role, actions, N1_LEGAL_ENTITY_ID, N1_TENANT_ID, roleKey).filter(
              (row) => row.resourceId !== moduleObject('core.shell').objectId,
            ),
          );
          const roleId = toScopedRoleObjectId({ legalEntityId: N1_LEGAL_ENTITY_ID, roleKey, tenantId: N1_TENANT_ID });
          for (const moduleId of readers) {
            rows.push(roleRelationship('module_access', moduleObject(moduleId).objectId, 'reader_role', roleId));
          }
        }
        return EffectArray.sortWith(
          [
            ...new Map(
              rows.filter(policyOnly).map((row) => {
                const native = asNative(row);
                return [v1.Relationship.toJsonString(native), native];
              }),
            ).entries(),
          ],
          ([key]) => key,
          Order.String,
        ).map(([, row]) => row);
      },
    });
  });

export interface N1PermissionCheck {
  readonly expected: boolean;
  readonly label: string;
  readonly permission: string;
  readonly principalId: string;
  readonly resource: { readonly objectId: string; readonly objectType: string };
}

/**
 * Actions an account may execute. Administrators reach company-scoped Actions but not tenant-only ones (principal
 * bindings, people-search rebuild). Catalogue managers execute only their module Actions, never the managed-key Action.
 */
const actionGrantedTo = (action: DemoAction, administrator: boolean) => {
  if (administrator) {
    return action.legalEntityScope !== 'forbidden';
  }
  return (
    (action.owningModuleKey === merchandise || action.owningModuleKey === markets) &&
    action.actionKey !== managedKeyAction
  );
};

type CheckAdder = (
  principalId: string,
  expected: boolean,
  resource: N1PermissionCheck['resource'],
  permission: string,
  label: string,
) => void;

/** Service principals: no staff rights, storefront and authority reads only, exact Actions. */
const serviceChecks = (access: N1Access, actions: readonly DemoAction[], add: CheckAdder) => {
  const tenant = { objectId: N1_TENANT_ID, objectType: 'tenant' };
  for (const principalId of Object.values(access.services)) {
    add(principalId, true, tenant, 'access', 'N1 service tenant admission');
    add(principalId, true, companyObject(), 'access', 'N1 service company admission');
    for (const permission of ['select_context', 'manage_identity']) {
      add(principalId, false, tenant, permission, `no staff tenant ${permission}`);
    }
    add(principalId, false, companyObject(), 'write_all', 'no service company administration');
    add(principalId, false, moduleObject('core.shell'), 'access', 'no service staff Shell');
    add(principalId, true, moduleObject(markets), 'read_all', 'N1 service Market resolution');
    add(principalId, true, resourceObject(rootResource), 'read', 'N1 Market catalog root read');
    for (const moduleId of [merchandise, workTasks]) {
      for (const permission of ['read_all', 'write_all']) {
        add(principalId, false, moduleObject(moduleId), permission, `no service staff ${moduleId} ${permission}`);
        // Only the storefront's explicit write gate is granted; no service receives the module-wide read_all.
        const granted = principalId === access.services.storefront && permission === 'write_all';
        add(
          principalId,
          granted,
          {
            objectId:
              toContextPermissionAccessObjectId(N1_TENANT_ID, N1_LEGAL_ENTITY_ID, {
                moduleId,
                permission: `${moduleId}.${permission}`,
              }) ?? '',
            objectType: 'context_permission',
          },
          'access',
          `${granted ? 'N1 service' : 'no service'} staff ${moduleId} context ${permission}`,
        );
      }
    }
    const grantedActionKeys: readonly string[] =
      principalId === access.services.storefront ? Object.values(storefrontActionKeys).flat() : [];
    for (const action of actions) {
      const granted = grantedActionKeys.includes(action.actionKey);
      add(
        principalId,
        granted,
        actionObject(action),
        'execute',
        `${granted ? 'N1 service' : 'no service'} Action ${action.actionKey}`,
      );
      if (action.legalEntityScope === 'optional') {
        add(principalId, false, actionObject(action, null), 'execute', `no service tenant Action ${action.actionKey}`);
      }
    }
  }
};

export const n1PermissionChecks = (access: N1Access, actions: readonly DemoAction[]) => {
  const checks: N1PermissionCheck[] = [];
  const add = (
    principalId: string,
    expected: boolean,
    resource: N1PermissionCheck['resource'],
    permission: string,
    label: string,
  ): void => {
    checks.push({ expected, label: `${principalId}: ${label}`, permission, principalId, resource });
  };
  const tenant = { objectId: N1_TENANT_ID, objectType: 'tenant' };
  for (const { email, principalId } of access.accounts) {
    const administrator = email === administratorEmail;
    // Company administration and Core people/role reach: administrator only. Catalogue manager: no staff rights.
    add(principalId, true, tenant, 'access', 'N1 tenant access');
    for (const permission of ['manage_identity', 'select_context']) {
      add(principalId, false, tenant, permission, `no tenant ${permission}`);
    }
    add(principalId, true, companyObject(), 'access', 'N1 company access');
    add(
      principalId,
      administrator,
      companyObject(),
      'write_all',
      `N1 company write_all administrator=${administrator}`,
    );
    add(principalId, administrator, companyObject(), 'read_people', `N1 company people administrator=${administrator}`);
    add(
      principalId,
      administrator,
      moduleObject('core.identity'),
      'access',
      `N1 people module administrator=${administrator}`,
    );
    for (const { moduleId } of n1ManifestSources) {
      // The catalogue manager reaches products and Markets only; the administrator covers every N1 module.
      const reachable = administrator || moduleId === markets || moduleId === merchandise;
      add(principalId, reachable, moduleObject(moduleId), 'access', `N1 module access ${moduleId}`);
      // Module-level write_all is company administration; catalogue writes go through the Actions checked below.
      add(
        principalId,
        administrator,
        moduleObject(moduleId),
        'write_all',
        `N1 module write_all administrator=${administrator} ${moduleId}`,
      );
    }
    for (const permission of ['demo.merchandise.read_all', 'demo.merchandise.write_all']) {
      add(
        principalId,
        true,
        {
          objectId:
            toContextPermissionAccessObjectId(N1_TENANT_ID, N1_LEGAL_ENTITY_ID, {
              moduleId: merchandise,
              permission,
            }) ?? '',
          objectType: 'context_permission',
        },
        'access',
        `N1 staff ${permission}`,
      );
    }
    for (const action of actions) {
      const granted = actionGrantedTo(action, administrator);
      add(
        principalId,
        granted,
        actionObject(action),
        'execute',
        `N1 Action ${action.actionKey} administrator=${administrator}`,
      );
    }
  }
  serviceChecks(access, actions, add);
  add(access.services.storefront, true, moduleObject(merchandise), 'access', 'N1 public catalog accessor');
  add(
    access.services['market-authority'],
    false,
    moduleObject(merchandise),
    'access',
    'authority cannot read products',
  );
  add(access.services.storefront, false, moduleObject(registry), 'access', 'storefront cannot administer registry');
  add(access.services['market-authority'], true, moduleObject(registry), 'read_all', 'authority registry read');
  add(
    access.services['market-authority'],
    true,
    resourceObject(storefrontResource),
    'read',
    'authority N1 storefront read',
  );
  const n1Scopes = [tenant, companyObject(), ...n1ManifestSources.map(({ moduleId }) => moduleObject(moduleId))];
  for (const principalId of oldPrincipals) {
    for (const resource of n1Scopes) {
      add(principalId, false, resource, 'access', `old principal denied N1 ${resource.objectId}`);
    }
  }
  for (const principalId of [
    ...access.accounts.map((account) => account.principalId),
    ...Object.values(access.services),
  ]) {
    for (const [tenantId, legalEntityId] of [
      [akrosPlaygroundTenantId, akrosPlaygroundLegalEntityId],
      [demoTenantId, akrosDemoLegalEntityId],
    ]) {
      add(principalId, false, { objectId: tenantId, objectType: 'tenant' }, 'access', `denied old tenant ${tenantId}`);
      add(principalId, false, companyObject(tenantId, legalEntityId), 'access', `denied old company ${legalEntityId}`);
    }
  }
  return checks;
};

const SavedPlanSchema = Schema.Struct({
  access: N1AccessSchema,
  checks: Schema.Array(
    Schema.Struct({
      expected: Schema.Boolean,
      label: Schema.String,
      permission: Schema.String,
      principalId: Schema.toEncoded(PrincipalIdSchema),
      resource: Schema.Struct({ objectId: Schema.toEncoded(ObjectIdSchema), objectType: Schema.String }),
    }),
  ),
  contracts: Schema.Array(
    Schema.Struct({
      appId: Schema.toEncoded(OntosDeploymentAppIdSchema),
      buildMarker: Schema.String,
      sha256: Schema.String,
    }),
  ),
  desired: Schema.Array(Schema.String),
  schemaVersion: Schema.Literal(1),
});

export const createN1GrantPlan = (access: N1Access, documents: readonly N1ContractDocument[]) =>
  Effect.gen(function* createPlan() {
    const { actions, contracts } = yield* decodeN1Contracts(documents);
    const relationships = yield* n1GrantRelationships(access, actions);
    const checks = n1PermissionChecks(access, actions);
    const text = yield* Schema.encodeEffect(Schema.fromJsonString(SavedPlanSchema))({
      access,
      checks,
      contracts,
      desired: relationships.map((row) => v1.Relationship.toJsonString(row)),
      schemaVersion: 1,
    });
    return { access, checks, fingerprint: n1PlanFingerprint(text), relationships, text };
  });
export type N1GrantPlan = Effect.Success<ReturnType<typeof createN1GrantPlan>>;

export const verifyN1Checks = (rpc: Pick<SpiceDbRpc, 'checkPermission'>, checks: readonly N1PermissionCheck[]) =>
  Effect.forEach(
    checks,
    (check) =>
      rpc
        .checkPermission(
          v1.CheckPermissionRequest.create({
            consistency: { requirement: { fullyConsistent: true, oneofKind: 'fullyConsistent' } },
            permission: check.permission,
            resource: check.resource,
            subject: { object: { objectId: check.principalId, objectType: 'principal' } },
          }),
        )
        .pipe(
          Effect.flatMap((result) => {
            const expected = check.expected
              ? v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION
              : v1.CheckPermissionResponse_Permissionship.NO_PERMISSION;
            return result.permissionship === expected
              ? Effect.void
              : Effect.fail(fail(`N1 permission assertion failed: ${check.label}`));
          }),
        ),
    { concurrency: 4, discard: true },
  );

/** Identity of a native relationship: the same tuple whether desired by the plan or read live. */
const relationshipIdentity = (relationship: v1.Relationship) =>
  [
    relationship.resource?.objectType ?? '',
    relationship.resource?.objectId ?? '',
    relationship.relation,
    relationship.subject?.object?.objectType ?? '',
    relationship.subject?.object?.objectId ?? '',
    relationship.subject?.optionalRelation ?? '',
  ].join('|');

/**
 * Exact deletes of stale N1 grants: every grant an account or service principal, or a service role, holds that the plan
 * does not desire. Company and tenant admission (membership, self) belongs to the native installers and is never
 * touched here. Absent rows are no-ops, so reruns converge.
 */
export const revokeRetiredN1Relationships = (
  rpc: Pick<SpiceDbRpc, 'readRelationships' | 'writeRelationships'>,
  plan: N1GrantPlan,
) =>
  Effect.gen(function* revokeRetired() {
    const desired = new Set(plan.relationships.map(relationshipIdentity));
    const admission = new Set(['principal', 'legal_entity', 'tenant']);
    const types = ONTOS_SPICEDB_SCHEMA.split('\n')
      .filter((line) => line.startsWith('definition '))
      .map((line) => line.split(' ')[1] ?? '');
    const principals = [
      ...plan.access.accounts.map(({ principalId }) => principalId),
      ...Object.values(plan.access.services),
    ];
    const serviceRoles = [storefrontName, marketAuthorityName].map((roleKey) =>
      toScopedRoleObjectId({ legalEntityId: N1_LEGAL_ENTITY_ID, roleKey, tenantId: N1_TENANT_ID }),
    );
    const filters = [
      ...principals.flatMap((optionalSubjectId) =>
        types
          .filter((resourceType) => !admission.has(resourceType))
          .map((resourceType) => ({
            optionalSubjectFilter: { optionalSubjectId, subjectType: 'principal' },
            resourceType,
          })),
      ),
      ...serviceRoles.flatMap((optionalSubjectId) =>
        types.map((resourceType) => ({
          optionalSubjectFilter: { optionalSubjectId, subjectType: 'scoped_role' },
          resourceType,
        })),
      ),
    ];
    const live = yield* Effect.forEach(
      filters,
      (filter) =>
        rpc.readRelationships(
          v1.ReadRelationshipsRequest.create({
            consistency: { requirement: { fullyConsistent: true, oneofKind: 'fullyConsistent' } },
            relationshipFilter: filter,
          }),
        ),
      { concurrency: 4 },
    );
    const updates = [
      // The tenant superadmin role is retired for N1: its tenant relation goes with the memberships revoked above.
      asNative(
        roleRelationship(
          'tenant',
          N1_TENANT_ID,
          'superadmin',
          toScopedRoleObjectId({ roleKey: 'superadmin', tenantId: N1_TENANT_ID }),
        ),
      ),
      ...live.flat().flatMap(({ relationship }) => (relationship === undefined ? [] : [relationship])),
    ]
      .filter((relationship) => !desired.has(relationshipIdentity(relationship)))
      .map((relationship) =>
        v1.RelationshipUpdate.create({ operation: v1.RelationshipUpdate_Operation.DELETE, relationship }),
      );
    if (updates.length === 0) {
      return;
    }
    yield* Console.log(`N1 stale grants revoked: ${updates.length}`);
    yield* rpc.writeRelationships(v1.WriteRelationshipsRequest.create({ updates }));
  });

/** Injected ports keep the approval-before-install/write ordering independently testable. */
export const executeN1ReviewedPlan = <E1, R1, E2, R2, E3, R3>(
  mode: 'apply' | 'verify',
  plan: N1GrantPlan,
  saved: string,
  reviewed: string | undefined,
  ports: {
    readonly installServices: Effect.Effect<unknown, E1, R1>;
    readonly reconcile: (mode: 'apply' | 'verify') => Effect.Effect<unknown, E2, R2>;
    readonly revoke: () => Effect.Effect<unknown, E2, R2>;
    readonly verify: (checks: readonly N1PermissionCheck[]) => Effect.Effect<unknown, E3, R3>;
  },
) =>
  Effect.gen(function* executeReviewed() {
    if (saved !== plan.text || reviewed !== plan.fingerprint || n1PlanFingerprint(saved) !== reviewed) {
      return yield* fail('The exact saved N1 plan, current live contracts, and reviewed fingerprint are required');
    }
    // Cross-tenant leaks of the retired principals are refused before any write. Account and service rights converge
    // through apply (stale grants are revoked) and are then checked in full below.
    const converged = new Set([
      ...plan.access.accounts.map(({ principalId }) => principalId),
      ...Object.values(plan.access.services),
    ]);
    yield* ports.verify(plan.checks.filter(({ expected, principalId }) => !expected && !converged.has(principalId)));
    if (mode === 'apply') {
      yield* ports.installServices;
      yield* ports.reconcile('apply');
      yield* ports.revoke();
    }
    yield* ports.reconcile('verify');
    return yield* ports.verify(plan.checks);
  });

const readPrivateFile = (path: string) =>
  Effect.gen(function* readPrivate() {
    const fs = yield* FileSystem.FileSystem;
    const stat = yield* fs.stat(path);
    if (stat.type !== 'File' || stat.mode % 0o100 !== 0 || stat.size > 4_000_000n) {
      return yield* fail('N1 input and plan must be bounded owner-only regular files, mode 600');
    }
    return yield* fs.readFileString(path);
  });

const run = (mode: Mode, planPath: string, reviewed: Option.Option<string>) =>
  Effect.gen(function* provisionN1() {
    yield* Config.schema(Schema.Literal('stage'), 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT');
    const input = yield* readPrivateFile(yield* Config.String('N1_ACCESS_FILE')).pipe(
      Effect.flatMap(decodeN1Access),
      Effect.mapError(() => fail('N1_ACCESS_FILE could not be privately decoded; values withheld')),
    );
    const plan = yield* createN1GrantPlan(input, yield* loadN1Contracts);
    const fs = yield* FileSystem.FileSystem;
    if (mode === 'plan') {
      yield* fs.writeFileString(planPath, plan.text, { flag: 'wx', mode: 0o600 });
      return yield* Console.log({
        checks: plan.checks.length,
        fingerprint: plan.fingerprint,
        mode,
        relationships: plan.relationships.length,
        tenantId: N1_TENANT_ID,
      });
    }
    const saved = yield* readPrivateFile(planPath);
    const environment = yield* Config.all({
      SPICEDB_CA_CERT: Config.String('SPICEDB_CA_CERT'),
      SPICEDB_ENDPOINT: Config.schema(Schema.Literal('spicedb:50051'), 'SPICEDB_ENDPOINT'),
      SPICEDB_PRESHARED_KEY: Config.Redacted('SPICEDB_PRESHARED_KEY'),
      ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: Config.schema(Schema.Literal('stage'), 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT'),
    });
    const configuration = yield* parseSpiceDbConfig({
      ...environment,
      SPICEDB_PRESHARED_KEY: Redacted.value(environment.SPICEDB_PRESHARED_KEY),
    });
    const rpc = yield* Effect.acquireRelease(
      Effect.try({
        catch: () => fail('The pinned native stage SpiceDB connection could not be opened'),
        try: () => openSpiceDbGrpcRpc(configuration, 10_000),
      }),
      (client) => Effect.sync(() => client.close()),
    );
    const provider = yield* ConfigProvider.ConfigProvider;
    yield* executeN1ReviewedPlan(mode, plan, saved, Option.getOrUndefined(reviewed), {
      installServices: reconcileStageServicePrincipals(n1ServiceDefinitions(plan.access), provider),
      reconcile: (grantMode) => reconcileServiceGrants(rpc, plan.relationships, grantMode),
      revoke: () => revokeRetiredN1Relationships(rpc, plan),
      verify: (checks) => verifyN1Checks(rpc, checks),
    });
    return yield* Console.log({ checks: plan.checks.length, failures: 0, fingerprint: plan.fingerprint, mode });
  }).pipe(Effect.scoped);

const command = Command.make(
  'n1-stage-grants',
  {
    mode: Flag.Literals('mode', modes),
    plan: Flag.String('plan'),
    reviewed: Flag.String('reviewed-plan-sha256').pipe(Flag.optional),
  },
  ({ mode, plan, reviewed }) =>
    run(mode, plan, reviewed).pipe(
      Effect.tapError(
        Effect.fnUntraced(function* reportN1Failure(failure) {
          return yield* Console.error(
            Schema.is(N1StageGrantError)(failure)
              ? failure.reason
              : `N1 grants stopped (${failure._tag}); credentials withheld`,
          );
        }),
      ),
    ),
);

if (import.meta.main) {
  const exit = await Effect.runPromiseExit(
    Command.run(command, { version: '1.0.0' }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(ProcessDatabasePoolsLive),
      Effect.provide(NodeServices.layer),
    ),
  );
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
