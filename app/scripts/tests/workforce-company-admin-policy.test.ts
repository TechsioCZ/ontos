import { v1 } from '@authzed/authzed-node';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { Config, Crypto, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { bootstrapRelationshipRequest } from '../../packages/core-runtime/src/install/context-bootstrap-shared.ts';
import { fullyConsistent } from '../../packages/core-runtime/src/permissions/client.ts';
import { parseSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import {
  toContextPermissionAccessObjectId,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
} from '../../packages/core-runtime/src/permissions/context-access.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../packages/core-runtime/src/permissions/schema.ts';
import { toScopedRoleObjectId } from '../../packages/core-runtime/src/permissions/scoped-role.ts';
import {
  toSpiceDbActionGrantObjectId,
  toSpiceDbActionObjectId,
} from '../../packages/core-runtime/src/permissions/service.ts';
import { openSpiceDbGrpcRpc } from '../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import { companyAdministratorWorkforceRelationships, roleRelationship } from '../demo/permissions.mts';
import type { DemoRelationship } from '../demo/permissions.mts';

const moduleId = 'demo.workforce';
const actionKey = 'demo.workforce.apply-command';
const contextPermissions = ['demo.workforce.read_all', 'demo.workforce.write_all'] as const;

const requireObjectId = (objectId: string | undefined): string => {
  if (objectId === undefined) {
    throw new Error('Expected a valid operation-owned SpiceDB object identifier');
  }
  return objectId;
};

const companyFixture = (tenantId: string, legalEntityId: string) => {
  const scope = { legalEntityId, tenantId };
  return {
    action: toSpiceDbActionObjectId({ ...scope, actionKey }),
    adminRole: toScopedRoleObjectId({ ...scope, roleKey: 'admin' }),
    grant: toSpiceDbActionGrantObjectId({ ...scope, actionKey }),
    legal: requireObjectId(toLegalEntityAccessObjectId(tenantId, legalEntityId)),
    legalEntityId,
    module: requireObjectId(toModuleAccessObjectId(tenantId, legalEntityId, moduleId)),
    permissions: contextPermissions.map((permission) =>
      requireObjectId(toContextPermissionAccessObjectId(tenantId, legalEntityId, { moduleId, permission })),
    ),
  };
};

type CompanyFixture = ReturnType<typeof companyFixture>;

const principalRelationship = (
  resourceType: string,
  resourceId: string,
  relation: string,
  principalId: string,
): DemoRelationship => ({ relation, resourceId, resourceType, subjectId: principalId, subjectType: 'principal' });

const companyRelationships = (
  tenantId: string,
  company: CompanyFixture,
  administrator: string,
): readonly DemoRelationship[] => [
  {
    relation: 'tenant',
    resourceId: company.legal,
    resourceType: 'legal_entity',
    subjectId: tenantId,
    subjectType: 'tenant',
  },
  principalRelationship('scoped_role', company.adminRole, 'member', administrator),
  roleRelationship('legal_entity', company.legal, 'admin', company.adminRole),
  {
    relation: 'legal_entity',
    resourceId: company.module,
    resourceType: 'module_access',
    subjectId: company.legal,
    subjectType: 'legal_entity',
  },
  {
    relation: 'company_scope',
    resourceId: company.action,
    resourceType: 'action',
    subjectId: company.legal,
    subjectType: 'legal_entity',
  },
  {
    relation: 'grant',
    resourceId: company.action,
    resourceType: 'action',
    subjectId: company.grant,
    subjectType: 'action_grant',
  },
];

const workforceCompanyAdministratorPolicy = Effect.gen(function* workforceCompanyAdministratorPolicy() {
  const configuration = yield* Config.all({
    ca: Config.Redacted('ONTOS_WORKFORCE_POLICY_SPICEDB_CA_CERT'),
    endpoint: Config.schema(
      Schema.String.check(Schema.isPattern(/^(?:127\.0\.0\.1|localhost|\[::1\]):[0-9]+$/u)),
      'ONTOS_WORKFORCE_POLICY_SPICEDB_ENDPOINT',
    ),
    isolated: Config.schema(Schema.Literal('true'), 'ONTOS_WORKFORCE_POLICY_SPICEDB_ISOLATED'),
    key: Config.Redacted('ONTOS_WORKFORCE_POLICY_SPICEDB_PRESHARED_KEY'),
  });
  // Parse the dedicated values only. loadSpiceDbConfig would read the workspace dotenv file.
  const settings = yield* parseSpiceDbConfig({
    SPICEDB_CA_CERT: Redacted.value(configuration.ca),
    SPICEDB_ENDPOINT: configuration.endpoint,
    SPICEDB_PRESHARED_KEY: Redacted.value(configuration.key),
  });
  const crypto = yield* Crypto.Crypto;
  const [tenantId, companyAId, companyBId, adminA, adminB, memberOnly] = yield* Effect.all(
    [
      crypto.randomUUIDv4(),
      crypto.randomUUIDv4(),
      crypto.randomUUIDv4(),
      crypto.randomUUIDv4(),
      crypto.randomUUIDv4(),
      crypto.randomUUIDv4(),
    ],
    { concurrency: 1 },
  );
  const companyA = companyFixture(tenantId, companyAId);
  const companyB = companyFixture(tenantId, companyBId);
  const membershipA = principalRelationship('legal_entity', companyA.legal, 'member', adminA);
  const roleA = principalRelationship('scoped_role', companyA.adminRole, 'member', adminA);
  const fixture = [
    ...companyRelationships(tenantId, companyA, adminA),
    ...companyRelationships(tenantId, companyB, adminB),
    ...[adminA, adminB, memberOnly].map((principalId) =>
      principalRelationship('tenant', tenantId, 'company_member', principalId),
    ),
    membershipA,
    principalRelationship('legal_entity', companyA.legal, 'member', adminB),
    principalRelationship('legal_entity', companyA.legal, 'member', memberOnly),
    // Both administrators retain real membership in B when A membership is revoked.
    ...[adminA, adminB].map((principalId) =>
      principalRelationship('legal_entity', companyB.legal, 'member', principalId),
    ),
  ];
  const policy = [
    ...companyAdministratorWorkforceRelationships(companyAId, tenantId),
    ...companyAdministratorWorkforceRelationships(companyBId, tenantId),
  ];
  const rpc = yield* Effect.acquireRelease(
    Effect.sync(() => openSpiceDbGrpcRpc(settings, 10_000)),
    (client) => Effect.sync(() => client.close()),
  );
  // A fresh engine returns gRPC NOT_FOUND (5). Refuse an initialized engine before any write.
  const absentSchema = yield* rpc.readSchema(v1.ReadSchemaRequest.create({})).pipe(Effect.flip);
  expect(Option.getOrUndefined(absentSchema.code), 'A fresh isolated SpiceDB must have no schema').toBe(5);
  const change = (rows: readonly DemoRelationship[], operation = v1.RelationshipUpdate_Operation.TOUCH) =>
    rpc.writeRelationships(
      v1.WriteRelationshipsRequest.create({
        updates: bootstrapRelationshipRequest(rows).updates.map((update) => ({ ...update, operation })),
      }),
    );
  // Finally-style cleanup is registered before the first write, including tuples not yet written.
  // Exact DELETEs cannot sweep unrelated objects; revoked tuples are safe to delete again.
  yield* Effect.addFinalizer(() =>
    change([...fixture, ...policy], v1.RelationshipUpdate_Operation.DELETE).pipe(Effect.orDie),
  );
  yield* rpc.writeSchema(v1.WriteSchemaRequest.create({ schema: ONTOS_SPICEDB_SCHEMA }));
  yield* change(fixture);

  const check = (
    principalId: string,
    [objectType, objectId, permission]: readonly [string, string, string],
    allowed: boolean,
  ) =>
    rpc
      .checkPermission(
        v1.CheckPermissionRequest.create({
          consistency: fullyConsistent,
          permission,
          resource: { objectId, objectType },
          subject: { object: { objectId: principalId, objectType: 'principal' } },
        }),
      )
      .pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.permissionship, `${objectType}#${permission} for ${principalId}`).toBe(
              allowed
                ? v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION
                : v1.CheckPermissionResponse_Permissionship.NO_PERMISSION,
            );
          }),
        ),
      );
  const checkNamedPermissions = (principalId: string, company: CompanyFixture, allowed: boolean) =>
    Effect.forEach(
      company.permissions,
      (objectId) => check(principalId, ['context_permission', objectId, 'access'], allowed),
      { concurrency: 1, discard: true },
    );
  const checkCapabilities = (principalId: string, company: CompanyFixture, allowed: boolean) =>
    Effect.all(
      [
        checkNamedPermissions(principalId, company, allowed),
        check(principalId, ['module_access', company.module, 'access'], allowed),
        check(principalId, ['action', company.action, 'execute'], allowed),
      ],
      { concurrency: 1, discard: true },
    );

  // Without the exported policy, company admin opens the module and executes the Action,
  // but neither named Workforce permission is implied by legal_entity#admin alone.
  yield* checkNamedPermissions(adminA, companyA, false);
  yield* checkNamedPermissions(adminB, companyB, false);
  yield* check(adminA, ['module_access', companyA.module, 'access'], true);
  yield* check(adminA, ['action', companyA.action, 'execute'], true);
  yield* change(policy);
  yield* checkCapabilities(adminA, companyA, true);
  yield* checkCapabilities(adminB, companyB, true);

  // Denial is not a missing-company-membership shortcut: both have admission to A.
  yield* check(memberOnly, ['legal_entity', companyA.legal, 'access'], true);
  yield* checkCapabilities(memberOnly, companyA, false);
  yield* check(adminB, ['legal_entity', companyA.legal, 'access'], true);
  yield* checkCapabilities(adminB, companyA, false);
  yield* check(adminA, ['legal_entity', companyB.legal, 'access'], true);
  yield* checkCapabilities(adminA, companyB, false);

  // Delete only company A membership: role and tenant admission remain, but all four gates deny.
  yield* change([membershipA], v1.RelationshipUpdate_Operation.DELETE);
  yield* check(adminA, ['tenant', tenantId, 'access'], true);
  yield* check(adminA, ['legal_entity', companyB.legal, 'access'], true);
  yield* check(adminA, ['legal_entity', companyA.legal, 'access'], false);
  yield* checkCapabilities(adminA, companyA, false);
  yield* change([membershipA]);
  yield* checkCapabilities(adminA, companyA, true);

  // Independently revoke only the exact scoped_role#member assignment; company admission survives.
  yield* change([roleA], v1.RelationshipUpdate_Operation.DELETE);
  yield* check(adminA, ['legal_entity', companyA.legal, 'access'], true);
  yield* checkCapabilities(adminA, companyA, false);
  yield* checkCapabilities(adminB, companyB, true);
});

// Deliberately .test.ts: the default scripts glob collects only .test.mts. Run this native
// acceptance explicitly with --project integration --include scripts/tests/workforce-company-admin-policy.test.ts.
// Requires a fresh, operation-owned, TLS-enabled loopback SpiceDB with no schema; never use a shared engine.
// This evaluates authorization only, not Workforce CreateEmployee persistence or principal assignment eligibility.
it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer), { excludeTestServices: true })(
  'native company administrator Workforce policy',
  (suite) => {
    suite.effect(
      'gates both named permissions, module access and Action execution by exact company admin membership',
      () => workforceCompanyAdministratorPolicy,
    );
  },
);
