#!/usr/bin/env node
/**
 * Stage-only, reviewed e-shop market grants: plan (read-only) → apply (exact reviewed plan) → verify.
 *
 * Additive SpiceDB policy for the e-shop personas, the AKROS storefront BFF and the Market owner gateway, plus the
 * static containment edges the Market and Storefront Registry resource permissions need (each company's Market
 * catalogue root and the two registered storefront applications). Runs inside the stage app container with the
 * supervisor environment; identity, membership and other modules stay owned by their installers.
 */
import { createHash } from 'node:crypto';

import {
  ownerResourceModuleContainment,
  toContextPermissionAccessObjectId,
  toModuleAccessObjectId,
  toResourceAccessObjectId,
} from '@app/core-runtime';
import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import { Config, Console, Effect, Exit, FileSystem, Layer, Option, Redacted, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { FetchHttpClient } from 'effect/http';

import {
  ActiveApplicationCompositionConfigLive,
  ActiveApplicationCompositionService,
} from '../../packages/core-runtime/src/modules/active-application-composition.ts';
import { ActiveApplicationCompositionSourceLive } from '../../packages/core-runtime/src/modules/active-application-composition-source.node.ts';
import { parseSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import { toSpiceDbActionObjectId } from '../../packages/core-runtime/src/permissions/service.ts';
import { openSpiceDbGrpcRpc } from '../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import { discoverCurrentActions } from '../provision-current-action-authorization.mts';
import {
  akrosDemoLegalEntityId,
  crmDemoLegalEntityId,
  demoLegalEntityId,
  demoTenantId,
  eshopDemoLegalEntityId,
} from './fixture-ids.mts';
import type { DemoAction, DemoRelationship, DemoRole } from './permissions.mts';
import {
  akrosStorefrontPrincipal,
  companyHumanAccounts,
  demoHumanAccounts,
  eshopDemoRoles,
  marketRetirementRelationships,
  principalRelationships,
  tenantAdministratorCrmRelationships,
} from './permissions.mts';
import { readMissingServiceGrants, reconcileServiceGrants } from './reconcile-stage-service-grants.mts';
import { ProcessDatabasePoolsLive } from '../zerops/process-database-pools.mts';

class EshopMarketGrantError extends Schema.TaggedError<EshopMarketGrantError>()('EshopMarketGrantError', {
  reason: Schema.String,
}) {}
const fail = (reason: string) => new EshopMarketGrantError({ reason });

const marketModule = 'commerce.market-catalog';
const storefrontRegistryModule = 'commerce.storefront-registry';
const eshopModules = [marketModule, storefrontRegistryModule] as const;
const modes = ['plan', 'apply', 'verify'] as const;

/** Registered storefront applications and the company whose module scope holds each registration. */
export const eshopStorefronts = [
  { appId: 'akros-storefront', legalEntityId: akrosDemoLegalEntityId },
  { appId: 'kavarna-doma-eshop', legalEntityId: eshopDemoLegalEntityId },
] as const;

export const eshopPersonaEmails = [
  'eshop@akros.demo',
  'eshop@kavarna.demo',
  'expedice@akros.demo',
  'expedice@kavarna.demo',
] as const;

const personas = (emails: readonly string[]) =>
  companyHumanAccounts.filter((candidate) => emails.includes(candidate.email));
const principalIdOf = (email: string) =>
  companyHumanAccounts.find((candidate) => candidate.email === email)?.principalId ?? '';

/** Only the e-shop market slice of a role. */
const eshopSlice = (role: DemoRole): DemoRole => ({
  label: role.label,
  modules: Object.fromEntries(
    eshopModules.flatMap((moduleId) => {
      const access = role.modules[moduleId];
      return access === undefined ? [] : [[moduleId, access]];
    }),
  ),
});

/** Identity and membership edges belong to the account installers, never to this additive policy. */
const baselineEdge = ({ relation, resourceType }: DemoRelationship) =>
  (resourceType === 'tenant' && relation === 'member') ||
  (resourceType === 'legal_entity' && (relation === 'member' || relation === 'tenant'));

const sliceRelationships = (
  principalId: string,
  role: DemoRole,
  actions: readonly DemoAction[],
  legalEntityId: string,
): readonly DemoRelationship[] => {
  const shell = toModuleAccessObjectId(demoTenantId, legalEntityId, 'core.shell');
  return principalRelationships(principalId, eshopSlice(role), actions, legalEntityId).filter(
    (item) => !baselineEdge(item) && item.resourceId !== shell,
  );
};

const containmentRelationship = (
  legalEntityId: string,
  resource: Readonly<{ moduleId: string; resourceId: string; resourceType: string }>,
): readonly DemoRelationship[] => {
  const edge = ownerResourceModuleContainment(demoTenantId, legalEntityId, resource);
  return edge === undefined
    ? []
    : [
        {
          relation: edge.relation,
          resourceId: edge.resource.objectId,
          resourceType: edge.resource.objectType,
          subjectId: edge.container.objectId,
          subjectType: edge.container.objectType,
        },
      ];
};

const toRelationship = (item: DemoRelationship) =>
  v1.Relationship.create({
    relation: item.relation,
    resource: { objectId: item.resourceId, objectType: item.resourceType },
    subject: {
      object: { objectId: item.subjectId, objectType: item.subjectType },
      optionalRelation: item.subjectRelation ?? '',
    },
  });

const roleOf = (key: string): DemoRole | undefined => {
  const roles: Readonly<Record<string, DemoRole>> = eshopDemoRoles;
  return roles[key];
};

export const eshopMarketGrantSource = (actions: readonly DemoAction[]): readonly DemoRelationship[] => [
  ...personas(eshopPersonaEmails).flatMap((account) => {
    const role = roleOf(account.role);
    return role === undefined ? [] : sliceRelationships(account.principalId, role, actions, account.legalEntityId);
  }),
  ...sliceRelationships(
    akrosStorefrontPrincipal.principalId,
    eshopDemoRoles.akrosStorefront,
    actions,
    akrosDemoLegalEntityId,
  ),
  ...marketRetirementRelationships(actions),
  ...[akrosDemoLegalEntityId, eshopDemoLegalEntityId].flatMap((legalEntityId) =>
    containmentRelationship(legalEntityId, {
      moduleId: marketModule,
      resourceId: legalEntityId,
      resourceType: 'commerce.market-catalog.market-catalog-root',
    }),
  ),
  ...eshopStorefronts.flatMap(({ appId, legalEntityId }) =>
    containmentRelationship(legalEntityId, {
      moduleId: storefrontRegistryModule,
      resourceId: appId,
      resourceType: 'commerce.storefront-registry.storefront-application',
    }),
  ),
  // Additive follow-up: the tenant superadmin sees and manages every client of the CRM company (admins can do everything).
  ...tenantAdministratorCrmRelationships(actions),
];

const relationshipKey = (item: DemoRelationship) =>
  `${item.resourceType}:${item.resourceId}#${item.relation}@${item.subjectType}:${item.subjectId}#${item.subjectRelation ?? ''}`;

export const eshopMarketGrantRelationships = (actions: readonly DemoAction[]): readonly v1.Relationship[] => [
  ...new Map(eshopMarketGrantSource(actions).map((item) => [relationshipKey(item), toRelationship(item)])).values(),
];

export interface EshopPermissionCheck {
  readonly expected: boolean;
  readonly label: string;
  readonly permission: string;
  readonly principalId: string;
  readonly resource: Readonly<{ objectId: string; objectType: string }>;
}

const actionObject = (actionKey: string, legalEntityId: string) => ({
  objectId: toSpiceDbActionObjectId({ actionKey, legalEntityId, tenantId: demoTenantId }),
  objectType: 'action',
});
const moduleObject = (legalEntityId: string, moduleId: string) => ({
  objectId: toModuleAccessObjectId(demoTenantId, legalEntityId, moduleId) ?? '',
  objectType: 'module_access',
});
const marketRoot = (legalEntityId: string) => ({
  objectId:
    toResourceAccessObjectId(demoTenantId, legalEntityId, {
      moduleId: marketModule,
      resourceId: legalEntityId,
      resourceType: 'commerce.market-catalog.market-catalog-root',
    }) ?? '',
  objectType: 'resource',
});

export const eshopMarketPermissionChecks = (): readonly EshopPermissionCheck[] => {
  const akrosAdmin = principalIdOf('eshop@akros.demo');
  const kavarnaAdmin = principalIdOf('eshop@kavarna.demo');
  const akrosFulfilment = principalIdOf('expedice@akros.demo');
  const storefront = akrosStorefrontPrincipal.principalId;
  const create = 'commerce.market-catalog.create-market';
  return [
    {
      expected: true,
      label: 'AKROS admin opens Market',
      permission: 'access',
      principalId: akrosAdmin,
      resource: moduleObject(akrosDemoLegalEntityId, marketModule),
    },
    {
      expected: true,
      label: 'AKROS admin creates Markets',
      permission: 'execute',
      principalId: akrosAdmin,
      resource: actionObject(create, akrosDemoLegalEntityId),
    },
    {
      expected: true,
      label: 'AKROS admin writes its Market root',
      permission: 'write',
      principalId: akrosAdmin,
      resource: marketRoot(akrosDemoLegalEntityId),
    },
    {
      expected: false,
      label: 'AKROS admin cannot write the Kavárna Market root',
      permission: 'write',
      principalId: akrosAdmin,
      resource: marketRoot(eshopDemoLegalEntityId),
    },
    {
      expected: false,
      label: 'AKROS admin cannot create Kavárna Markets',
      permission: 'execute',
      principalId: akrosAdmin,
      resource: actionObject(create, eshopDemoLegalEntityId),
    },
    {
      expected: true,
      label: 'Kavárna admin writes its Market root',
      permission: 'write',
      principalId: kavarnaAdmin,
      resource: marketRoot(eshopDemoLegalEntityId),
    },
    {
      expected: true,
      label: 'Kavárna admin opens Storefront Registry',
      permission: 'access',
      principalId: kavarnaAdmin,
      resource: moduleObject(eshopDemoLegalEntityId, storefrontRegistryModule),
    },
    {
      expected: true,
      label: 'AKROS fulfilment reads Market',
      permission: 'access',
      principalId: akrosFulfilment,
      resource: moduleObject(akrosDemoLegalEntityId, marketModule),
    },
    {
      expected: false,
      label: 'AKROS fulfilment cannot retire Markets',
      permission: 'execute',
      principalId: akrosFulfilment,
      resource: actionObject('commerce.market-catalog.retire-market', akrosDemoLegalEntityId),
    },
    {
      expected: true,
      label: 'AKROS storefront resolves Markets',
      permission: 'access',
      principalId: storefront,
      resource: moduleObject(akrosDemoLegalEntityId, marketModule),
    },
    {
      expected: false,
      label: 'AKROS storefront cannot create Markets',
      permission: 'execute',
      principalId: storefront,
      resource: actionObject(create, akrosDemoLegalEntityId),
    },
    {
      expected: true,
      label: 'Tenant superadmin opens CRM in Obchodní firma',
      permission: 'access',
      principalId: demoHumanAccounts[0].principalId,
      resource: moduleObject(demoLegalEntityId, 'demo.crm'),
    },
    {
      expected: true,
      label: 'Tenant superadmin reads every Hanák CRM client',
      permission: 'access',
      principalId: demoHumanAccounts[0].principalId,
      resource: {
        objectId:
          toContextPermissionAccessObjectId(demoTenantId, crmDemoLegalEntityId, {
            moduleId: 'demo.crm',
            permission: 'demo.crm.read_all',
          }) ?? '',
        objectType: 'context_permission',
      },
    },
  ];
};

const sameEncoded = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const PlanSchema = Schema.Struct({
  compositionRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  desired: Schema.Array(Schema.String),
  missing: Schema.Array(Schema.String),
});
const encodedRelationships = (relationships: readonly v1.Relationship[]) =>
  relationships.map((relationship) => v1.Relationship.toJsonString(relationship));
export const eshopMarketPlanFingerprint = (relationships: readonly v1.Relationship[]) =>
  createHash('sha256').update(encodedRelationships(relationships).join('\n')).digest('hex');

const main = (mode: (typeof modes)[number], planPath: string, reviewed: Option.Option<string>) =>
  Effect.gen(function* eshopMarketGrants() {
    const environment = yield* Config.all({
      SPICEDB_CA_CERT: Config.String('SPICEDB_CA_CERT'),
      SPICEDB_ENDPOINT: Config.schema(Schema.Literal('spicedb:50051'), 'SPICEDB_ENDPOINT'),
      SPICEDB_PRESHARED_KEY: Config.Redacted('SPICEDB_PRESHARED_KEY'),
      ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: Config.schema(Schema.Literal('stage'), 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT'),
    });
    const spice = yield* parseSpiceDbConfig({
      ...environment,
      SPICEDB_PRESHARED_KEY: Redacted.value(environment.SPICEDB_PRESHARED_KEY),
    });
    const rpc = yield* Effect.acquireRelease(
      Effect.try({
        catch: () => fail('Pinned SpiceDB channel could not be opened'),
        try: () => openSpiceDbGrpcRpc(spice, 10_000),
      }),
      (client) => Effect.sync(() => client.close()),
    );
    const snapshot = yield* (yield* ActiveApplicationCompositionService).load;
    const actions = yield* discoverCurrentActions(snapshot);
    if (personas(eshopPersonaEmails).length !== eshopPersonaEmails.length) {
      return yield* fail('An e-shop persona is missing from the demo account policy');
    }
    if (!eshopModules.every((moduleId) => actions.some(({ owningModuleKey }) => owningModuleKey === moduleId))) {
      return yield* fail('The active composition does not publish the e-shop market Actions');
    }
    const desired = yield* Effect.try({
      catch: () => fail('The e-shop market policy is invalid'),
      try: () => eshopMarketGrantRelationships(actions),
    });
    const digest = eshopMarketPlanFingerprint(desired);
    const filesystem = yield* FileSystem.FileSystem;
    if (mode === 'plan') {
      const missing = yield* readMissingServiceGrants(rpc, desired);
      const plan = yield* Schema.encodeEffect(Schema.fromJsonString(PlanSchema))({
        compositionRevision: snapshot.composition.revision,
        desired: encodedRelationships(desired),
        missing: encodedRelationships(missing),
      });
      yield* filesystem.writeFileString(planPath, plan, { flag: 'wx', mode: 0o600 });
      return yield* Console.log({ desired: desired.length, fingerprint: digest, missing: missing.length, mode });
    }
    const saved = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PlanSchema))(
      yield* filesystem.readFileString(planPath),
    );
    if (
      Option.isNone(reviewed) ||
      reviewed.value !== digest ||
      saved.compositionRevision !== snapshot.composition.revision ||
      !sameEncoded(saved.desired, encodedRelationships(desired))
    ) {
      return yield* fail('The exact reviewed plan, fingerprint and composition are required');
    }
    if (mode === 'apply') {
      yield* reconcileServiceGrants(rpc, desired, 'apply');
    }
    yield* reconcileServiceGrants(rpc, desired, 'verify');
    const checks = eshopMarketPermissionChecks();
    for (const check of checks) {
      const response = yield* rpc.checkPermission(
        v1.CheckPermissionRequest.create({
          consistency: { requirement: { fullyConsistent: true, oneofKind: 'fullyConsistent' } },
          permission: check.permission,
          resource: check.resource,
          subject: { object: { objectId: check.principalId, objectType: 'principal' } },
        }),
      );
      const allowed = response.permissionship === v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION;
      if (allowed !== check.expected) {
        return yield* fail(`Permission assertion failed: ${check.label}`);
      }
    }
    return yield* Console.log({
      checks: checks.length,
      desired: desired.length,
      failures: 0,
      fingerprint: digest,
      mode,
    });
  }).pipe(Effect.scoped);

const command = Command.make(
  'eshop-markets-stage-grants',
  {
    mode: Flag.Literals('mode', modes),
    plan: Flag.String('plan'),
    reviewed: Flag.String('reviewed-plan-sha256').pipe(Flag.optional),
  },
  ({ mode, plan, reviewed }) =>
    main(mode, plan, reviewed).pipe(
      Effect.tapError((failure) =>
        Console.error(
          Schema.is(EshopMarketGrantError)(failure)
            ? failure.reason
            : 'E-shop market grants stopped; credentials and provider details withheld',
        ),
      ),
    ),
);

if (import.meta.main) {
  const services = ActiveApplicationCompositionConfigLive.pipe(
    Layer.provide(ActiveApplicationCompositionSourceLive),
    Layer.provide(FetchHttpClient.layer),
    Layer.provideMerge(NodeServices.layer),
  );
  const exit = await Effect.runPromiseExit(
    Command.run(command, { version: '1.0.0' }).pipe(
      // Operator processes own their database pool registry like every Node host (Core pools are host-scoped).
      Effect.provide(ProcessDatabasePoolsLive),
      Effect.provide(services),
    ),
  );
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
