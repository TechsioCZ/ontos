import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import { Effect, Result } from 'effect';
import type { Cause } from 'effect';
import { expect, it } from 'effect-rstest';

import type {
  AccessProjectionIntent,
  ScopeProjectionIntent,
  TenantProjectionIntent,
} from '../../src/access/compiler/intent.ts';
import { capabilityObjectId, scopeObjectId } from '../../src/access/compiler/object-id.ts';
import { AccessProjectionError } from '../../src/access/compiler/projection-error.ts';
import type { ProjectionUnitKey } from '../../src/access/compiler/relationship.ts';
import {
  ACCESS_PROJECTION_MAX_UPDATES_PER_WRITE,
  makeAccessProjectionCompiler,
  makeAccessProjectionTransport,
} from '../../src/access/compiler/spice-db-compiler.ts';
import type { ProjectionFenceAssertion } from '../../src/access/compiler/spice-db-compiler.ts';
import { loadSpiceDbConfig } from '../../src/permissions/config.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../src/permissions/schema.ts';
import { newSpiceDbGrpcClient } from '../../src/permissions/spicedb-grpc-rpc.ts';
import {
  ADMIN,
  ALICE,
  BOB,
  CAP_MARGINS,
  CAP_NOTE,
  CAP_PAY,
  DELEGATION,
  ENTITY,
  NEXT_REVISION,
  OTHER_SCOPE,
  ROLE,
  SCOPE,
  TENANT,
  assignment,
  capabilityKey,
  cell,
  ceiling,
  delegation,
  human,
  legalEntityId,
  partyEntry,
  revision,
  scopeIntent,
  targetsSelector,
  tenantIntent,
} from '../unit/access-compiler-fixtures.ts';

const HAS = v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION;
const NO = v1.CheckPermissionResponse_Permissionship.NO_PERMISSION;
const fullyConsistent = v1.Consistency.create({ requirement: { fullyConsistent: true, oneofKind: 'fullyConsistent' } });
const OTHER_ENTITY = legalEntityId(90);
const HUMAN = 'access_human';

interface CompilerContext {
  readonly check: (
    resourceType: string,
    resourceId: string,
    permission: string,
    subjectId: string,
    context?: Record<string, number | string>,
  ) => Effect.Effect<number, Cause.UnknownError>;
  readonly cleanup: (intent: AccessProjectionIntent) => Effect.Effect<void, readonly AccessProjectionError[]>;
  readonly compile: (
    intent: AccessProjectionIntent,
    removedUnits?: readonly ProjectionUnitKey[],
    fence?: ProjectionFenceAssertion,
  ) => Effect.Effect<CompileReport, readonly AccessProjectionError[]>;
  readonly verify: (intent: AccessProjectionIntent) => Effect.Effect<boolean, readonly AccessProjectionError[]>;
}

/** The fence a writer holds for every scope it reconciles (D15). */
const heldFence: ProjectionFenceAssertion = () => Effect.void;

/** A fence another operation holds, so this writer may neither read a plan nor write one. */
const unheldFence: ProjectionFenceAssertion = (scope) =>
  Effect.fail([
    new AccessProjectionError({
      code: 'access_projection_unavailable',
      reason: `The fence of scope ${scope.scopeId} is held by another access operation`,
    }),
  ]);

interface CompileReport {
  readonly deletions: number;
  readonly touches: number;
  readonly verified: boolean;
}

/** The same tenant with no facts: reconciling it deletes every tuple of these units. */
const emptyIntent = (intent: AccessProjectionIntent): AccessProjectionIntent => ({
  tenants: intent.tenants.map((tenant): TenantProjectionIntent => ({
    ...tenant,
    legalEntities: tenant.legalEntities.map((entity) => ({
      ...entity,
      accessAdmins: [],
      members: [],
      suspended: [],
    })),
    members: [],
    owners: [],
    scopes: tenant.scopes.map((scope): ScopeProjectionIntent =>
      scopeIntent({
        assignments: [],
        connections: [],
        delegations: [],
        installations: [],
        roleRevisions: [],
        scope: scope.scope,
      }),
    ),
    suspended: [],
  })),
});

/**
 * The compiler under test is the only writer of the v2 definitions; this suite checks the graph it
 * produced and then removes it, so the container stays shared with the other access suites. The
 * failure type stays inferred: each case adds its own refusals to the transport and config errors.
 */
const withCompiler = <Value, Failure>(program: (context: CompilerContext) => Effect.Effect<Value, Failure>) =>
  Effect.gen(function* compilerSuite() {
    const configuration = yield* loadSpiceDbConfig();
    const client = yield* Effect.acquireRelease(
      Effect.sync(() => newSpiceDbGrpcClient(configuration)),
      (current) => Effect.sync(() => current.close()),
    );
    yield* Effect.tryPromise(() =>
      client.promises.writeSchema(v1.WriteSchemaRequest.create({ schema: ONTOS_SPICEDB_SCHEMA })),
    );
    const compiler = makeAccessProjectionCompiler(makeAccessProjectionTransport(configuration));
    const check = (
      resourceType: string,
      resourceId: string,
      permission: string,
      subjectId: string,
      context?: Record<string, number | string>,
    ): Effect.Effect<number, Cause.UnknownError> =>
      Effect.tryPromise(() => {
        const request = v1.CheckPermissionRequest.create({
          consistency: fullyConsistent,
          permission,
          resource: v1.ObjectReference.create({ objectId: resourceId, objectType: resourceType }),
          subject: v1.SubjectReference.create({
            object: v1.ObjectReference.create({ objectId: subjectId, objectType: HUMAN }),
          }),
        });
        if (context !== undefined) {
          request.context = v1.createStructFromObject(context);
        }
        return client.promises.checkPermission(request);
      }).pipe(Effect.map((response) => response.permissionship));
    const compile = (
      intent: AccessProjectionIntent,
      removedUnits: readonly ProjectionUnitKey[] = [],
      fence: ProjectionFenceAssertion = heldFence,
    ): Effect.Effect<CompileReport, readonly AccessProjectionError[]> =>
      compiler.reconcile(intent, { fence, removedUnits }).pipe(
        Effect.map((report) => ({
          deletions: report.deletions,
          touches: report.touches,
          verified: report.verified,
        })),
      );
    const cleanup = (intent: AccessProjectionIntent): Effect.Effect<void, readonly AccessProjectionError[]> =>
      Effect.asVoid(compiler.reconcile(emptyIntent(intent), { fence: heldFence }));
    const verify = (intent: AccessProjectionIntent): Effect.Effect<boolean, readonly AccessProjectionError[]> =>
      compiler.verify(intent).pipe(Effect.map((verification) => verification.ok));
    return yield* program({ check, cleanup, compile, verify });
  }).pipe(Effect.scoped);

const singleScope = (scope: Partial<ScopeProjectionIntent>, tenant: Partial<TenantProjectionIntent> = {}) => ({
  tenants: [tenantIntent({ ...tenant, scopes: [scopeIntent(scope)] })],
});

/** One scope whose only role grants `pay` at `limit`, so a narrowing is one tuple's content. */
const ceilingIntent = (limit: number): AccessProjectionIntent =>
  singleScope({
    roleRevisions: [
      revision({ cells: [cell({ amountCeiling: ceiling(limit), capabilityKey: CAP_PAY, mode: 'run' })] }),
    ],
  });

/** One scope whose only role grants `pay` on an explicit target set. */
const targetIntent = (...recordKeys: string[]): AccessProjectionIntent =>
  singleScope({
    roleRevisions: [
      revision({ cells: [cell({ capabilityKey: CAP_PAY, mode: 'run', selector: targetsSelector(recordKeys) })] }),
    ],
  });

/** Two legal entities in one tenant, so cross-entity isolation is checked on real tuples. */
const twoEntityScope = (): AccessProjectionIntent => ({
  tenants: [
    tenantIntent({
      legalEntities: [
        { accessAdmins: [ADMIN], legalEntityId: ENTITY, members: [{ holder: human(ALICE) }], suspended: [] },
        { accessAdmins: [ADMIN], legalEntityId: OTHER_ENTITY, members: [{ holder: human(BOB) }], suspended: [] },
      ],
      scopes: [
        scopeIntent({ assignments: [assignment()] }),
        scopeIntent({
          assignments: [assignment({ holder: human(BOB), scopeId: OTHER_SCOPE })],
          scope: { id: OTHER_SCOPE, scope: { _tag: 'LegalEntity', legalEntityId: OTHER_ENTITY, tenantId: TENANT } },
        }),
      ],
    }),
  ],
});

it.layer(NodeServices.layer, { excludeTestServices: true })('access projection compiler', (suite) => {
  suite.effect('writes membership, cells and configuration, then repeats as a no-op', () =>
    withCompiler(({ check, cleanup, compile, verify }) =>
      Effect.gen(function* writeProjection() {
        const intent = singleScope({
          roleRevisions: [
            revision({
              cells: [
                cell({ capabilityKey: CAP_PAY, mode: 'run' }),
                cell({ capabilityKey: CAP_NOTE, mode: 'propose' }),
              ],
            }),
          ],
        });
        yield* cleanup(intent);
        const first = yield* compile(intent);
        expect(first.verified).toBe(true);
        expect(first.touches).toBeGreaterThan(0);
        expect(first.deletions).toBe(0);

        const capability = capabilityObjectId(TENANT, SCOPE, CAP_PAY);
        expect(yield* check('access_capability', capability, 'run_all', ALICE)).toBe(HAS);
        expect(yield* check('access_capability', capability, 'propose_all', ALICE)).toBe(NO);
        expect(yield* check('access_capability', capability, 'run_all', BOB)).toBe(NO);
        expect(yield* check('access_capability', capability, 'configure', ADMIN)).toBe(HAS);
        expect(yield* check('access_capability', capability, 'configure', BOB)).toBe(NO);
        expect(yield* check('access_scope', scopeObjectId(TENANT, SCOPE), 'access', ALICE)).toBe(HAS);
        expect(yield* check('access_scope', scopeObjectId(TENANT, SCOPE), 'administer', ADMIN)).toBe(HAS);

        expect(yield* compile(intent)).toEqual({ deletions: 0, touches: 0, verified: true });
        expect(yield* verify(intent)).toBe(true);
        yield* cleanup(intent);
        // Verification reads intent, so a projection that is gone is drift, never a clean pass.
        expect(yield* verify(intent)).toBe(false);
        expect(yield* check('access_capability', capability, 'run_all', ALICE)).toBe(NO);
      }),
    ),
  );

  suite.effect('stops every use on uninstall, keeps configuration and restores it on reinstall', () =>
    withCompiler(({ check, cleanup, compile }) =>
      Effect.gen(function* uninstallProjection() {
        const intent = singleScope({});
        yield* cleanup(intent);
        yield* compile(intent);
        const capability = capabilityObjectId(TENANT, SCOPE, CAP_PAY);
        expect(yield* check('access_capability', capability, 'run_all', ALICE)).toBe(HAS);

        const uninstalled = yield* compile(singleScope({ installations: [] }));
        expect(uninstalled.verified).toBe(true);
        expect(yield* check('access_capability', capability, 'run_all', ALICE)).toBe(NO);
        expect(yield* check('access_capability', capability, 'configure', ADMIN)).toBe(HAS);

        yield* compile(intent);
        expect(yield* check('access_capability', capability, 'run_all', ALICE)).toBe(HAS);
        yield* cleanup(intent);
      }),
    ),
  );

  suite.effect('drops a revoked assignment and keeps another legal entity out of reach', () =>
    withCompiler(({ check, cleanup, compile }) =>
      Effect.gen(function* revokeAndIsolate() {
        const intent = twoEntityScope();
        yield* cleanup(intent);
        yield* compile(intent);
        expect(yield* check('access_capability', capabilityObjectId(TENANT, SCOPE, CAP_PAY), 'run_all', ALICE)).toBe(
          HAS,
        );
        expect(
          yield* check('access_capability', capabilityObjectId(TENANT, OTHER_SCOPE, CAP_PAY), 'run_all', ALICE),
        ).toBe(NO);
        expect(
          yield* check('access_capability', capabilityObjectId(TENANT, OTHER_SCOPE, CAP_PAY), 'run_all', BOB),
        ).toBe(HAS);

        const revoked = twoEntityScope();
        const [tenant] = revoked.tenants;
        expect(tenant === undefined).toBe(false);
        const revokedIntent: AccessProjectionIntent = {
          tenants: [
            {
              ...(tenant ?? { ...tenantIntent(), scopes: [] }),
              scopes: [
                scopeIntent({
                  assignments: [assignment({ status: 'revoked' })],
                  roleRevisions: [revision()],
                }),
                scopeIntent({
                  assignments: [assignment({ holder: human(BOB), scopeId: OTHER_SCOPE })],
                  scope: {
                    id: OTHER_SCOPE,
                    scope: { _tag: 'LegalEntity', legalEntityId: OTHER_ENTITY, tenantId: TENANT },
                  },
                }),
              ],
            },
          ],
        };
        yield* compile(revokedIntent);
        expect(yield* check('access_capability', capabilityObjectId(TENANT, SCOPE, CAP_PAY), 'run_all', ALICE)).toBe(
          NO,
        );
        expect(
          yield* check('access_capability', capabilityObjectId(TENANT, OTHER_SCOPE, CAP_PAY), 'run_all', BOB),
        ).toBe(HAS);
        yield* cleanup(revokedIntent);
      }),
    ),
  );

  suite.effect('enforces the amount ceiling caveat against the request', () =>
    withCompiler(({ check, cleanup, compile }) =>
      Effect.gen(function* amountCeiling() {
        const intent = singleScope({
          roleRevisions: [
            revision({ cells: [cell({ amountCeiling: ceiling(10_000), capabilityKey: CAP_PAY, mode: 'run' })] }),
          ],
        });
        yield* cleanup(intent);
        yield* compile(intent);
        const capability = capabilityObjectId(TENANT, SCOPE, CAP_PAY);
        expect(
          yield* check('access_capability', capability, 'run_all', ALICE, { amount_minor: 0, currency: 'CZK' }),
        ).toBe(HAS);
        expect(
          yield* check('access_capability', capability, 'run_all', ALICE, { amount_minor: 10_000, currency: 'CZK' }),
        ).toBe(HAS);
        expect(
          yield* check('access_capability', capability, 'run_all', ALICE, { amount_minor: 10_001, currency: 'CZK' }),
        ).toBe(NO);
        expect(
          yield* check('access_capability', capability, 'run_all', ALICE, { amount_minor: 10, currency: 'EUR' }),
        ).toBe(NO);
        yield* cleanup(intent);
      }),
    ),
  );

  suite.effect('lets a delegated manager configure a capability it may never run', () =>
    withCompiler(({ check, cleanup, compile }) =>
      Effect.gen(function* delegatedManager() {
        const intent = singleScope({
          delegations: [delegation({ capabilityKeys: [CAP_PAY], id: DELEGATION, people: [ALICE], roleIds: [ROLE] })],
        });
        yield* cleanup(intent);
        yield* compile(intent);
        expect(yield* check('access_capability', capabilityObjectId(TENANT, SCOPE, CAP_PAY), 'configure', BOB)).toBe(
          HAS,
        );
        expect(yield* check('access_capability', capabilityObjectId(TENANT, SCOPE, CAP_PAY), 'run_all', BOB)).toBe(NO);
        expect(yield* check('access_capability', capabilityObjectId(TENANT, SCOPE, CAP_NOTE), 'configure', BOB)).toBe(
          NO,
        );
        yield* cleanup(intent);
      }),
    ),
  );

  suite.effect('applies a role edit as a small write and narrows the engine exactly', () =>
    withCompiler(({ check, cleanup, compile }) =>
      Effect.gen(function* roleEdit() {
        const wide = singleScope({
          roleRevisions: [
            revision({
              cells: [
                cell({ capabilityKey: CAP_PAY, mode: 'run' }),
                cell({ capabilityKey: CAP_NOTE, mode: 'run' }),
                cell({ capabilityKey: CAP_MARGINS, mode: 'propose' }),
              ],
            }),
          ],
        });
        yield* cleanup(wide);
        yield* compile(wide);
        const pay = capabilityObjectId(TENANT, SCOPE, CAP_PAY);
        const note = capabilityObjectId(TENANT, SCOPE, CAP_NOTE);
        expect(yield* check('access_capability', note, 'run_all', ALICE)).toBe(HAS);

        const narrow = singleScope({
          assignments: [assignment({ roleRevisionId: NEXT_REVISION })],
          roleRevisions: [
            revision({
              cells: [
                cell({ capabilityKey: CAP_PAY, mode: 'run' }),
                cell({ capabilityKey: CAP_MARGINS, mode: 'propose' }),
              ],
              id: NEXT_REVISION,
              revision: 2,
            }),
          ],
        });
        const report = yield* compile(narrow);
        expect(report.verified).toBe(true);
        expect(report.deletions).toBeGreaterThan(0);
        expect(report.deletions).toBeLessThan(10);
        expect(yield* check('access_capability', note, 'run_all', ALICE)).toBe(NO);
        expect(yield* check('access_capability', pay, 'run_all', ALICE)).toBe(HAS);
        yield* cleanup(narrow);
        expect(yield* check('access_capability', pay, 'run_all', ALICE)).toBe(NO);
      }),
    ),
  );

  suite.effect('refuses to read or write a scope whose fence it does not hold (M3)', () =>
    withCompiler(({ check, cleanup, compile }) =>
      Effect.gen(function* fenceRequired() {
        const intent = singleScope({});
        yield* cleanup(intent);
        const refused = yield* Effect.result(compile(intent, [], unheldFence));
        expect(Result.isFailure(refused)).toBe(true);
        expect(Result.isFailure(refused) ? refused.failure.map((error) => error.code) : []).toContain(
          'access_projection_unavailable',
        );
        // Nothing was read or written: the capability is not in the graph at all.
        expect(yield* check('access_capability', capabilityObjectId(TENANT, SCOPE, CAP_PAY), 'run_all', ALICE)).toBe(
          NO,
        );
        yield* cleanup(intent);
      }),
    ),
  );

  suite.effect('narrows an amount ceiling as one touch, never as a write the engine refuses (H4)', () =>
    withCompiler(({ check, cleanup, compile }) =>
      Effect.gen(function* narrowedCeiling() {
        const capability = capabilityObjectId(TENANT, SCOPE, CAP_PAY);
        yield* cleanup(ceilingIntent(10_000));
        yield* compile(ceilingIntent(10_000));
        expect(
          yield* check('access_capability', capability, 'run_all', ALICE, { amount_minor: 7000, currency: 'CZK' }),
        ).toBe(HAS);

        const report = yield* compile(ceilingIntent(5000));
        expect(report.verified).toBe(true);
        expect(report.deletions).toBe(0);
        expect(report.touches).toBe(1);
        expect(
          yield* check('access_capability', capability, 'run_all', ALICE, { amount_minor: 7000, currency: 'CZK' }),
        ).toBe(NO);
        expect(
          yield* check('access_capability', capability, 'run_all', ALICE, { amount_minor: 4000, currency: 'CZK' }),
        ).toBe(HAS);
        yield* cleanup(ceilingIntent(5000));
      }),
    ),
  );

  suite.effect('shrinks an explicit target set through one touch of the same tuple (H4)', () =>
    withCompiler(({ check, cleanup, compile }) =>
      Effect.gen(function* shrunkTargets() {
        const capability = capabilityObjectId(TENANT, SCOPE, CAP_PAY);
        const runOn = (recordKey: string) =>
          check('access_capability', capability, 'run_all', ALICE, { resource_key: recordKey });
        yield* cleanup(targetIntent('invoice-1', 'invoice-2'));
        yield* compile(targetIntent('invoice-1', 'invoice-2'));
        expect(yield* runOn('invoice-2')).toBe(HAS);

        const report = yield* compile(targetIntent('invoice-1'));
        expect(report.verified).toBe(true);
        expect(report.deletions).toBe(0);
        expect(report.touches).toBe(1);
        expect(yield* runOn('invoice-2')).toBe(NO);
        expect(yield* runOn('invoice-1')).toBe(HAS);
        yield* cleanup(targetIntent('invoice-1'));
      }),
    ),
  );

  suite.effect('projects a scope whose tuple count exceeds one write request (M4)', () =>
    withCompiler(({ cleanup, compile }) =>
      Effect.gen(function* batchedWrite() {
        const keys = Array.from({ length: 300 }, (_, index) => capabilityKey(`party.registry.party.cap-${index}`));
        const intent = singleScope(
          { roleRevisions: [revision({ cells: keys.map((key) => cell({ capabilityKey: key, mode: 'run' })) })] },
          { catalogEntries: keys.map((key) => partyEntry(key)) },
        );
        yield* cleanup(intent);
        const report = yield* compile(intent);
        expect(report.verified).toBe(true);
        expect(report.touches).toBeGreaterThan(ACCESS_PROJECTION_MAX_UPDATES_PER_WRITE);
        expect(report.deletions).toBe(0);
        yield* cleanup(intent);
      }),
    ),
  );
});
