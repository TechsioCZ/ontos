#!/usr/bin/env node
/**
 * Stage operator: grants each seeded Project Owner the explicit `assign` eligibility on that Project's prefix
 * (`seed-projects.mts`). Owner eligibility is a target grant, never tenant membership, so without it no one can
 * own a seeded Project. It only TOUCHes the tenant link and the named Owner of each seeded prefix.
 *
 *   node scripts/demo/projects-owner-eligibility-stage.mts [--apply]
 *
 * Runs inside the stage app container (stage-private SpiceDB).
 */
import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import { Console, Effect, Exit, Layer, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';

import { bootstrapRelationshipRequest } from '../../packages/core-runtime/src/install/context-bootstrap-shared.ts';
import type { BootstrapRelationship } from '../../packages/core-runtime/src/install/context-bootstrap-shared.ts';
import { loadSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import { toTenantResourceAccessObjectId } from '../../packages/core-runtime/src/permissions/context-access.ts';
import { openSpiceDbGrpcRpc } from '../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import { projectOwnerEligibilityTarget } from '../../verticals/projects/src/services/project-owner-eligibility.service.ts';
import { personaPrincipalIds } from './company-content.mts';
import { demoTenantId } from './fixture-ids.mts';
import { projectSpecs } from './seed-projects.mts';

class ProjectOwnerEligibilityFailure extends Schema.TaggedError<ProjectOwnerEligibilityFailure>()(
  'ProjectOwnerEligibilityFailure',
  { reason: Schema.String },
) {}
const fail = (reason: string) => new ProjectOwnerEligibilityFailure({ reason });

const eligibilityGrants = Effect.forEach(
  projectSpecs,
  (spec) => {
    const principalId = personaPrincipalIds.get(spec.owner);
    const objectId = toTenantResourceAccessObjectId(demoTenantId, projectOwnerEligibilityTarget(spec.prefix));
    return principalId === undefined || objectId === undefined
      ? Effect.fail(fail(`Owner ${spec.owner} of ${spec.prefix} has no demo principal`))
      : Effect.succeed({ objectId, prefix: spec.prefix, principalId });
  },
  { concurrency: 1 },
);

const relationshipsFor = (grant: { readonly objectId: string; readonly principalId: string }) =>
  [
    {
      relation: 'tenant',
      resourceId: grant.objectId,
      resourceType: 'tenant_resource',
      subjectId: demoTenantId,
      subjectType: 'tenant',
    },
    {
      relation: 'assignee',
      resourceId: grant.objectId,
      resourceType: 'tenant_resource',
      subjectId: grant.principalId,
      subjectType: 'principal',
    },
  ] satisfies readonly BootstrapRelationship[];

const main = (apply: boolean) =>
  Effect.gen(function* grantProjectOwnerEligibility() {
    const configuration = yield* loadSpiceDbConfig({ envPath: '/dev/null' });
    if (configuration.deploymentEnvironment !== 'stage' || configuration.endpoint !== 'spicedb:50051') {
      return yield* fail('Project Owner eligibility requires the actual stage environment and stage-private SpiceDB');
    }
    const grants = yield* eligibilityGrants;
    const client = yield* Effect.acquireRelease(
      Effect.try({ catch: () => fail('SpiceDB is unreachable'), try: () => openSpiceDbGrpcRpc(configuration, 5000) }),
      (value) => Effect.sync(() => value.close()),
    );
    const eligible = Effect.forEach(
      grants,
      (grant) =>
        client
          .checkPermission(
            v1.CheckPermissionRequest.create({
              consistency: { requirement: { fullyConsistent: true, oneofKind: 'fullyConsistent' } },
              permission: 'assign',
              resource: { objectId: grant.objectId, objectType: 'tenant_resource' },
              subject: { object: { objectId: grant.principalId, objectType: 'principal' } },
            }),
          )
          .pipe(
            Effect.map(
              (response) => response.permissionship === v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION,
            ),
          ),
      { concurrency: 4 },
    );
    const before = yield* eligible;
    if (apply) {
      yield* client.writeRelationships(bootstrapRelationshipRequest(grants.flatMap(relationshipsFor)));
      const after = yield* eligible;
      if (after.some((allowed) => !allowed)) {
        return yield* fail('A seeded Owner is still not eligible after the grant');
      }
    }
    const missing = grants.filter((_grant, index) => !before[index]).map((grant) => grant.prefix);
    const verb = apply ? 'granted' : 'missing';
    return yield* Console.log(`Project Owner eligibility ${verb}: ${missing.length} [${missing.join(', ')}]`);
  }).pipe(Effect.scoped);

const command = Command.make(
  'projects-owner-eligibility-stage',
  { apply: Flag.Boolean('apply').pipe(Flag.withDefault(false)) },
  ({ apply }) =>
    main(apply).pipe(
      Effect.tapError((failure) =>
        Console.error(
          Schema.is(ProjectOwnerEligibilityFailure)(failure)
            ? failure.reason
            : `Project Owner eligibility stopped (${failure._tag}); provider details withheld`,
        ),
      ),
    ),
);

if (import.meta.main) {
  const runtime = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
    Layer.provide(NodeServices.layer),
  );
  const result = await Effect.runPromiseExit(Effect.scoped(Layer.build(runtime)));
  process.exitCode = Exit.isFailure(result) ? 1 : 0;
}
