import { NodeChildProcessSpawner, NodeServices } from '@effect/platform-node';
import { Context, Effect, Exit, Layer, Option, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { ActionHandlerContext } from '../../src/actions/context.ts';
import { readScopedCurrentActionInvocation } from '../../src/actions/current-invocation.ts';
import type { ScopedCurrentActionInvocationFact } from '../../src/actions/current-invocation.ts';
import { defineAction } from '../../src/actions/definition.ts';
import { ActionRuntime } from '../../src/actions/runtime.ts';
import { AuthenticationNamespaceRegistry } from '../../src/auth/external-identity/verifier.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { OperationContextUnavailable } from '../../src/operations/errors.ts';
import { makeLiveOperationFixture } from '../../src/testing/actions.ts';
import { makeIsolatedNativeDatabaseFixture } from '../../src/testing/isolated-native-database.ts';
import { fixtureActionAccess } from '../support/access-declaration-fixtures.ts';
import { makeTestOperationOwner } from '../support/action-runtime-options.ts';

const actionKey = 'party.registry.current-action-fact-fixture';
const idempotencyKey = 'ab567890-1234-4567-89ab-123456789abc';
const noDomainEvents = {};
interface Services {
  readonly fact: ScopedCurrentActionInvocationFact;
}
const nativeServices = NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer));

it.layer(nativeServices, { excludeTestServices: true })('native current Action facts', (suite) => {
  suite.effect(
    'uses the real Action factory seal and native running row, then expires after completion',
    () =>
      Effect.gen(function* actualRunningActionFact() {
        const closedReads: Effect.Effect<ScopedCurrentActionInvocationFact, OperationContextUnavailable>[] = [];
        const registration = defineAction(
          {
            accessDeclaration: fixtureActionAccess('party.registry'),
            accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'current-action-fact-fixture.v1' },
            actionKey,
            auditProfile: 'standard',
            domainErrorSchema: Schema.Never,
            domainEvents: noDomainEvents,
            entrypoint: defineTenantModuleEntrypoint({
              access: 'write',
              authorization: { kind: 'protected' },
              entrypointKey: actionKey,
              moduleKey: 'party.registry',
              role: 'action',
            }),
            idempotency: 'required',
            legalEntityScope: 'required',
            owningModuleKey: 'party.registry',
            payloadSchema: Schema.Struct({}),
            policies: [],
            resultSchema: Schema.String,
            schemaVersion: '1',
          },
          (_payload, context: ActionHandlerContext<typeof noDomainEvents, Services>) => {
            expect(context.services.fact.actionInvocationId).toBe(context.actionInvocationId);
            expect(context.services.fact.actionKey).toBe(actionKey);
            expect(context.services.fact.idempotencyKey).toEqual(Option.some(idempotencyKey));
            expect(context.services.fact.principalId).toBe(context.scope.principalId);
            expect(context.services.fact.tenantId).toBe(context.scope.tenantId);
            expect(context.services.fact.legalEntityId).toEqual(Option.some(context.scope.legalEntityId));
            return Effect.succeed(context.services.fact.actionInvocationId);
          },
          Effect.fn('CurrentActionNativeFixture.services')(function* services(transaction, scope) {
            const fact = yield* readScopedCurrentActionInvocation(transaction, scope);
            expect(Object.isFrozen(fact)).toBe(true);
            const copied = Object.defineProperties({ ...transaction }, Object.getOwnPropertyDescriptors(transaction));
            for (const refusal of [
              readScopedCurrentActionInvocation({ ...transaction }, scope),
              readScopedCurrentActionInvocation(copied, scope),
              readScopedCurrentActionInvocation(transaction, { ...scope }),
            ]) {
              expect(Exit.isFailure(yield* Effect.exit(refusal))).toBe(true);
            }
            closedReads.push(readScopedCurrentActionInvocation(transaction, scope));
            return { fact };
          }),
        );
        const owner = makeTestOperationOwner({ actions: [registration], moduleId: 'party.registry' });
        const isolated = yield* makeIsolatedNativeDatabaseFixture({
          mode: 'empty',
          purpose: 'stabilization-1287-core-operation-fence',
        });
        yield* isolated.migrateCoreSchema();
        const live = yield* makeLiveOperationFixture({
          access: 'allowed',
          actionKeys: [actionKey],
          adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
          authenticationNamespaceId: 'current-action-fact-native',
          compositionRevision: owner.composition.revision,
          ownerRegistration: owner.ownerRegistration,
          runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
        });
        yield* Effect.addFinalizer(() => live.close().pipe(Effect.orDie));
        const fixtureContext = yield* Layer.build(live.layer);
        const runtime = Context.get(fixtureContext, ActionRuntime);
        yield* Effect.gen(function* executeWithNativeIdentityRegistry() {
          const invocationId = yield* runtime.runAction({
            payload: {},
            principal: { ...live.manager, legalEntityId: live.legalEntityId },
            registration,
            transport: { correlationId: 'native-current-action-fact', idempotencyKey },
          });
          expect(invocationId).toMatch(/^[a-f\d-]{36}$/u);
          expect(closedReads).toHaveLength(1);
          for (const escaped of closedReads) {
            expect(Schema.is(OperationContextUnavailable)(yield* escaped.pipe(Effect.flip))).toBe(true);
          }
          const outsideAction = yield* live.prepareOwner(
            (transaction, scope) => readScopedCurrentActionInvocation(transaction, scope).pipe(Effect.exit),
            'required',
          );
          expect(Exit.isFailure(outsideAction)).toBe(true);
        }).pipe(
          Effect.provideService(
            AuthenticationNamespaceRegistry,
            Context.get(fixtureContext, AuthenticationNamespaceRegistry),
          ),
        );
      }),
    60_000,
  );
});
