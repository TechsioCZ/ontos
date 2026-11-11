import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { eq } from 'drizzle-orm';
import { Crypto, DateTime, Effect, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { AccessOperationIdSchema, CommandDigestSchema, TenantIdSchema } from '../../src/access/ids.ts';
import { tenantContextScopeId } from '../../src/access/bootstrap/persistence.ts';
import { openOperationJournal, advanceOperationJournal } from '../../src/access/lifecycle/fence.ts';
import { makeAccessWriteJournalStore } from '../../src/access/lifecycle/persistence/journal-store.ts';
import { defineAction } from '../../src/actions/definition.ts';
import { ActionPermissionCheckError } from '../../src/actions/errors.ts';
import { ActionRuntime, runAction } from '../../src/actions/runtime.ts';
import { makeCoreDatabase } from '../../src/db/client.ts';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { defineDatabaseIdentityEnrollment } from '../../src/db/database-identities.ts';
import { accessScopeFences } from '../../src/db/schema.ts';
import { ActiveApplicationCompositionService } from '../../src/modules/active-application-composition.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import {
  OwnerAuthorizationOverlay,
  failClosedOwnerAuthorizationOverlay,
} from '../../src/access/enforcement/owner-overlay.ts';
import { makeNativeReadTestContext } from '../../src/testing/native-reads.ts';
import { publishTestApplicationCompositionAuthority } from '../../src/testing/owner-evidence.ts';
import { makeTestOperationOwner } from '../support/action-runtime-options.ts';

const MODULE_KEY = 'test.native-fixture';

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer), { excludeTestServices: true })(
  'Native fixture access fence',
  (suite) => {
    suite.effect(
      'native owner Action fixtures seed real access fences and a Changing fence still refuses an allowed Action',
      () =>
        Effect.gen(function* nativeFixtureAccessFence() {
          let handlerCalls = 0;
          const probeErrorFields = { reason: Schema.String };
          const probeErrorSchema = Schema.TaggedStruct('ProbeRejected', probeErrorFields);
          const ProbeRejected = Schema.TaggedError<typeof probeErrorSchema.Type>()('ProbeRejected', probeErrorFields);
          const probe = defineAction(
            {
              accessDeclaration: {
                key: 'test.native-fixture.probe.run',
                kind: 'action',
                modes: ['run'],
                placement: { group: 'probe', level: 'basic' },
                risk: 'routine',
                selectors: [],
              },
              accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'test.native-fixture.probe' },
              actionKey: 'test.native-fixture.probe',
              auditProfile: 'standard',
              domainErrorSchema: ProbeRejected,
              domainEvents: {},
              entrypoint: defineTenantModuleEntrypoint({
                access: 'write',
                authorization: { kind: 'protected' },
                entrypointKey: 'test.native-fixture.probe',
                moduleKey: MODULE_KEY,
                role: 'action',
              }),
              idempotency: 'required',
              legalEntityScope: 'required',
              owningModuleKey: MODULE_KEY,
              payloadSchema: Schema.Struct({}),
              policies: [],
              resultSchema: Schema.Struct({ reached: Schema.Literal(true) }),
              schemaVersion: '1',
            },
            () =>
              Effect.sync(() => {
                handlerCalls += 1;
                return { reached: true as const };
              }),
          );
          const owner = makeTestOperationOwner({ actions: [probe], moduleId: MODULE_KEY });
          const snapshot = yield* owner.snapshot;
          const connections = yield* loadDatabaseConnectionPair();
          const admin = yield* makeCoreDatabase(connections.admin);
          yield* publishTestApplicationCompositionAuthority(admin.executor, snapshot);
          const unusedReadFixture = yield* makeNativeReadTestContext({
            contextPermissions: [],
            moduleId: MODULE_KEY,
            ownerFixtureRetention: 'retain-complete-context',
          });
          const unusedFences = yield* admin.executor
            .select()
            .from(accessScopeFences)
            .where(eq(accessScopeFences.tenantId, unusedReadFixture.principal.tenantId));
          expect(unusedFences).toEqual([]);
          const fixture = yield* makeNativeReadTestContext(
            {
              access: 'allowed',
              contextPermissions: [],
              expectedDeployment: owner.expectedDeployment,
              moduleId: MODULE_KEY,
              ownerFixtureRetention: 'retain-complete-context',
            },
            owner.ownerRegistration,
          ).pipe(
            Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }),
            Effect.provideService(OwnerAuthorizationOverlay, failClosedOwnerAuthorizationOverlay),
          );
          const actionRuntime = yield* Effect.fromOption(Option.fromUndefinedOr(fixture.actionRuntime));
          const fixtureContext = yield* Layer.build(
            Layer.merge(fixture.layer, Layer.succeed(ActionRuntime, actionRuntime)),
          );
          const positive = yield* runAction({
            audience: owner.expectedDeployment.appId,
            payload: {},
            principal: fixture.principal,
            registration: probe,
            transport: { correlationId: 'native-ready-fence', idempotencyKey: 'native-ready-fence' },
          }).pipe(Effect.provide(fixtureContext));
          expect(positive).toEqual({ reached: true });
          expect(handlerCalls).toBe(1);
          const fences = yield* admin.executor
            .select()
            .from(accessScopeFences)
            .where(eq(accessScopeFences.tenantId, fixture.principal.tenantId));
          expect(fences).toHaveLength(2);
          expect(fences.every((fence) => fence.state === 'Ready')).toBe(true);
          const database = yield* makeCoreDatabase(connections.runtime);
          const store = makeAccessWriteJournalStore({
            enrollment: defineDatabaseIdentityEnrollment([]),
            executor: database.executor,
          });
          const scope = yield* fixture
            .prepareOwner((_transaction, trustedScope) => Effect.succeed(trustedScope))
            .pipe(Effect.provide(fixtureContext));
          const tenantId = TenantIdSchema.make(fixture.principal.tenantId);
          const scopeId = tenantContextScopeId(tenantId);
          const crypto = yield* Crypto.Crypto;
          const operationId = AccessOperationIdSchema.make(yield* crypto.randomUUIDv4());
          const journal = yield* openOperationJournal({
            commandDigest: CommandDigestSchema.make('a'.repeat(64)),
            operationId,
            scopeId,
            startedAt: yield* DateTime.nowAsDate,
            tenantId,
          });
          yield* store.writeJournal(scope, journal);
          yield* store.acquireFence(scope, { expectedRevision: 1, operationId, scopeId, tenantId });
          yield* Effect.gen(function* changingFenceControl() {
            const failure = yield* Effect.flip(
              runAction({
                audience: owner.expectedDeployment.appId,
                payload: {},
                principal: fixture.principal,
                registration: probe,
                transport: { correlationId: 'native-changing-fence', idempotencyKey: 'native-changing-fence' },
              }).pipe(Effect.provide(fixtureContext)),
            );
            expect(Schema.is(ActionPermissionCheckError)(failure)).toBe(true);
            expect(handlerCalls).toBe(1);
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* releaseControlFence() {
                const failed = yield* advanceOperationJournal({
                  current: journal,
                  failureCode: 'native_fixture_control_complete',
                  operationId,
                  phase: 'failed',
                  updatedAt: yield* DateTime.nowAsDate,
                });
                yield* store.writeJournal(scope, failed);
                yield* store.releaseFence(scope, { expectedRevision: 2, operationId, scopeId, tenantId });
              }).pipe(Effect.orDie),
            ),
          );
        }),
    );
  },
);
