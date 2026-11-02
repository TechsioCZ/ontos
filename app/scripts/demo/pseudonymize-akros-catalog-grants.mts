#!/usr/bin/env node
/**
 * Stage-only, reviewed catalog-operator grant: plan (read-only) → apply (exact reviewed plan) → verify.
 *
 * The demo company's (…024) catalog edits require a tenant administrator (merchandise command guard) AND the
 * company's merchandise rights. The tenant superadmin is the administrator but holds no merchandise rights there,
 * so no principal could run the catalog pseudonymization. This additive policy gives the superadmin exactly
 * `demo.merchandise.read_all` + `write_all` in that company and only the `demo.merchandise.apply-command` Action
 * (like the superadmin's CRM grant). Verify proves the grant and that no other company and nothing in the
 * akros-playground tenant changed. Runs inside the stage app container with the supervisor environment.
 */
import { createHash } from 'node:crypto';

import { toContextPermissionAccessObjectId, toModuleAccessObjectId } from '@app/core-runtime';
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
import { ProcessDatabasePoolsLive } from '../zerops/process-database-pools.mts';
import { akrosPlaygroundLegalEntityId, akrosPlaygroundTenantId } from './akros-playground-policy.mts';
import {
  akrosDemoLegalEntityId,
  crmDemoLegalEntityId,
  demoLegalEntityId,
  demoTenantId,
  eshopDemoLegalEntityId,
  rentalDemoLegalEntityId,
} from './fixture-ids.mts';
import type { DemoAction, DemoRelationship } from './permissions.mts';
import { demoHumanAccounts, principalRelationships } from './permissions.mts';
import { readMissingServiceGrants, reconcileServiceGrants } from './reconcile-stage-service-grants.mts';

class CatalogGrantError extends Schema.TaggedError<CatalogGrantError>()('CatalogGrantError', {
  reason: Schema.String,
}) {}
const fail = (reason: string) => new CatalogGrantError({ reason });

const merchandiseModule = 'demo.merchandise';
export const catalogOperatorAction = 'demo.merchandise.apply-command';
const catalogOperatorRoleKey = 'tenant-administrator-catalog';
const [tenantAdministrator] = demoHumanAccounts;
export const catalogOperatorPrincipalId = tenantAdministrator.principalId;

/** Only the demo company's merchandise rights and the one Action the operator dispatches; no membership edges. */
export const catalogOperatorRelationships = (actions: readonly DemoAction[]): readonly DemoRelationship[] =>
  principalRelationships(
    catalogOperatorPrincipalId,
    {
      actionKeys: { [merchandiseModule]: [catalogOperatorAction] },
      label: 'Správce tenantu',
      modules: { [merchandiseModule]: 'write' },
    },
    actions,
    akrosDemoLegalEntityId,
    demoTenantId,
    catalogOperatorRoleKey,
  ).filter(
    (item) => !(item.relation === 'member' && (item.resourceType === 'tenant' || item.resourceType === 'legal_entity')),
  );

const toRelationship = (item: DemoRelationship) =>
  v1.Relationship.create({
    relation: item.relation,
    resource: { objectId: item.resourceId, objectType: item.resourceType },
    subject: {
      object: { objectId: item.subjectId, objectType: item.subjectType },
      optionalRelation: item.subjectRelation ?? '',
    },
  });
const relationshipKey = (item: DemoRelationship) =>
  `${item.resourceType}:${item.resourceId}#${item.relation}@${item.subjectType}:${item.subjectId}#${item.subjectRelation ?? ''}`;
export const catalogOperatorGrants = (actions: readonly DemoAction[]): readonly v1.Relationship[] => [
  ...new Map(
    catalogOperatorRelationships(actions).map((item) => [relationshipKey(item), toRelationship(item)]),
  ).values(),
];

export interface CatalogPermissionProbe {
  readonly label: string;
  readonly permission: string;
  readonly resource: Readonly<{ objectId: string; objectType: string }>;
  /** `granted` must hold after apply; `unchanged` must equal the plan's reading; `denied` must stay false. */
  readonly rule: 'denied' | 'granted' | 'unchanged';
}
const contextPermission = (tenantId: string, legalEntityId: string, permission: string) => ({
  objectId:
    toContextPermissionAccessObjectId(tenantId, legalEntityId, { moduleId: merchandiseModule, permission }) ?? '',
  objectType: 'context_permission',
});
const actionObject = (tenantId: string, legalEntityId: string, actionKey: string) => ({
  objectId: toSpiceDbActionObjectId({ actionKey, legalEntityId, tenantId }),
  objectType: 'action',
});
const merchandiseProbes = (
  tenantId: string,
  legalEntityId: string,
  company: string,
  rule: CatalogPermissionProbe['rule'],
): readonly CatalogPermissionProbe[] => [
  ...['demo.merchandise.read_all', 'demo.merchandise.write_all'].map((permission) => ({
    label: `${company}: ${permission}`,
    permission: 'access',
    resource: contextPermission(tenantId, legalEntityId, permission),
    rule,
  })),
  ...[catalogOperatorAction, 'demo.merchandise.bootstrap-playground-catalog'].map((actionKey) => ({
    label: `${company}: execute ${actionKey}`,
    permission: 'execute',
    resource: actionObject(tenantId, legalEntityId, actionKey),
    rule,
  })),
];
/** Positive proof in the demo company plus the negative proof everywhere else (other companies, AKROS playground). */
export const catalogOperatorProbes = (): readonly CatalogPermissionProbe[] => [
  ...merchandiseProbes(demoTenantId, akrosDemoLegalEntityId, 'ŠroubShop', 'granted').filter(
    ({ label }) => !label.endsWith('bootstrap-playground-catalog'),
  ),
  {
    label: 'ŠroubShop: open merchandise',
    permission: 'access',
    resource: {
      objectId: toModuleAccessObjectId(demoTenantId, akrosDemoLegalEntityId, merchandiseModule) ?? '',
      objectType: 'module_access',
    },
    rule: 'granted',
  },
  ...merchandiseProbes(demoTenantId, akrosDemoLegalEntityId, 'ŠroubShop', 'unchanged').filter(({ label }) =>
    label.endsWith('bootstrap-playground-catalog'),
  ),
  ...[
    { company: 'Obchodní firma', legalEntityId: demoLegalEntityId },
    { company: 'Nájempark', legalEntityId: rentalDemoLegalEntityId },
    { company: 'Velkoobchod Hanák', legalEntityId: crmDemoLegalEntityId },
    { company: 'Kavárna Doma', legalEntityId: eshopDemoLegalEntityId },
  ].flatMap(({ company, legalEntityId }) => merchandiseProbes(demoTenantId, legalEntityId, company, 'unchanged')),
  ...merchandiseProbes(akrosPlaygroundTenantId, akrosPlaygroundLegalEntityId, 'AKROS playground', 'denied'),
  {
    label: 'AKROS playground: tenant access',
    permission: 'access',
    resource: { objectId: akrosPlaygroundTenantId, objectType: 'tenant' },
    rule: 'denied',
  },
];

const PlanSchema = Schema.Struct({
  baseline: Schema.Record(Schema.String, Schema.Boolean),
  compositionRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  desired: Schema.Array(Schema.String),
  missing: Schema.Array(Schema.String),
});
const encodedRelationships = (relationships: readonly v1.Relationship[]) =>
  relationships.map((relationship) => v1.Relationship.toJsonString(relationship));
export const catalogGrantFingerprint = (relationships: readonly v1.Relationship[]) =>
  createHash('sha256').update(encodedRelationships(relationships).join('\n')).digest('hex');
const sameEncoded = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const modes = ['plan', 'apply', 'verify'] as const;
const main = (mode: (typeof modes)[number], planPath: string, reviewed: Option.Option<string>) =>
  Effect.gen(function* catalogOperatorGrant() {
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
    if (!actions.some(({ actionKey }) => actionKey === catalogOperatorAction)) {
      return yield* fail('The active composition does not publish the merchandise apply-command Action');
    }
    const desired = yield* Effect.try({
      catch: () => fail('The catalog operator policy is invalid'),
      try: () => catalogOperatorGrants(actions),
    });
    const digest = catalogGrantFingerprint(desired);
    const probes = catalogOperatorProbes();
    const readProbe = (probe: CatalogPermissionProbe) =>
      rpc
        .checkPermission(
          v1.CheckPermissionRequest.create({
            consistency: { requirement: { fullyConsistent: true, oneofKind: 'fullyConsistent' } },
            permission: probe.permission,
            resource: probe.resource,
            subject: { object: { objectId: catalogOperatorPrincipalId, objectType: 'principal' } },
          }),
        )
        .pipe(
          Effect.map(
            (response) =>
              [
                probe.label,
                response.permissionship === v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION,
              ] as const,
          ),
        );
    const readProbes = Effect.all(probes.map(readProbe), { concurrency: 1 });
    const filesystem = yield* FileSystem.FileSystem;
    if (mode === 'plan') {
      const missing = yield* readMissingServiceGrants(rpc, desired);
      const baseline = Object.fromEntries(yield* readProbes);
      yield* filesystem.writeFileString(
        planPath,
        yield* Schema.encodeEffect(Schema.fromJsonString(PlanSchema))({
          baseline,
          compositionRevision: snapshot.composition.revision,
          desired: encodedRelationships(desired),
          missing: encodedRelationships(missing),
        }),
        { flag: 'wx', mode: 0o600 },
      );
      return yield* Console.log({
        baseline,
        desired: desired.length,
        fingerprint: digest,
        missing: missing.length,
        mode,
      });
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
    const after = new Map(yield* readProbes);
    const failures = probes.filter(({ label, rule }) => {
      const allowed = after.get(label);
      if (rule === 'granted') {
        return allowed !== true;
      }
      if (rule === 'denied') {
        return allowed !== false;
      }
      return allowed !== saved.baseline[label];
    });
    if (failures.length > 0) {
      return yield* fail(`Permission assertions failed: ${failures.map(({ label }) => label).join('; ')}`);
    }
    return yield* Console.log({
      checks: probes.length,
      desired: desired.length,
      failures: 0,
      fingerprint: digest,
      mode,
    });
  }).pipe(Effect.scoped);

const command = Command.make(
  'pseudonymize-akros-catalog-grants',
  {
    mode: Flag.Literals('mode', modes),
    plan: Flag.String('plan'),
    reviewed: Flag.String('reviewed-plan-sha256').pipe(Flag.optional),
  },
  ({ mode, plan, reviewed }) =>
    main(mode, plan, reviewed).pipe(
      Effect.tapError((failure) =>
        Console.error(
          Schema.is(CatalogGrantError)(failure)
            ? failure.reason
            : 'Catalog operator grant stopped; credentials and provider details withheld',
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
    Command.run(command, { version: '1.0.0' }).pipe(Effect.provide(ProcessDatabasePoolsLive), Effect.provide(services)),
  );
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
