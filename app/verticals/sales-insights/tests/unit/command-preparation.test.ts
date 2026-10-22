import { ContextAccess } from '@app/core-runtime';
import type { ContextAccessService, OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import {
  getActionServiceFactory,
  runActionOwnerSteps,
} from '../../../../packages/core-runtime/src/actions/definition.ts';
import {
  insideDatabaseTransaction,
  refuseInsideDatabaseTransaction,
} from '../../../../packages/core-runtime/src/db/transaction-io-guard.ts';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ApplyCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';

const scope: OperationalScope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: '10000000-0000-4000-8000-000000000001',
    authContextRef: 'session:preparation',
    authMethod: 'session',
    legalEntityId: '30000000-0000-4000-8000-000000000001',
    principalId: '40000000-0000-4000-8000-000000000001',
    tenantId: '20000000-0000-4000-8000-000000000001',
  }),
  correlationId: 'command-preparation',
};

it.effect(
  'resolves remote grants before BEGIN; the production service factory and command write remain owner-only',
  () =>
    Effect.gen(function* commandPreparation() {
      const remoteCalls: string[] = [];
      const access: ContextAccessService = {
        contextPermissions: ({ targets }) =>
          refuseInsideDatabaseTransaction('spicedb', 'context permissions').pipe(
            Effect.andThen(
              Effect.sync(() => {
                remoteCalls.push('context');
                return targets.map((target) => ({
                  decision: 'allowed' as const,
                  key: `${target.moduleId}:${target.permission}`,
                }));
              }),
            ),
          ),
        legalEntities: ({ legalEntityIds }) =>
          refuseInsideDatabaseTransaction('spicedb', 'legal entities').pipe(
            Effect.andThen(Effect.succeed(legalEntityIds.map((key) => ({ decision: 'allowed' as const, key })))),
          ),
        modules: ({ moduleIds }) =>
          refuseInsideDatabaseTransaction('spicedb', 'lookup modules').pipe(
            Effect.andThen(Effect.succeed(moduleIds.map((key) => ({ decision: 'allowed' as const, key })))),
          ),
        resources: () => Effect.die('Module-wide grants must skip resource RPCs'),
        tenants: () => Effect.die('These commands do not request tenant permissions'),
      };
      const stateRows: readonly never[] = [];
      const written = Effect.succeed([{ revision: 1 }]);
      // oxlint-disable sonarjs/no-nested-functions -- This test fixture mirrors the nested fluent SQL API, not nested business logic.
      // SAFETY: This test executor supports exactly the fluent owner queries exercised below; unimplemented SQL must not run.
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- The test deliberately implements only the owner SQL used by this Action.
      const transaction = {
        insert: () => ({
          values: () =>
            Object.assign(
              Effect.suspend(() => Effect.void),
              { onConflictDoNothing: () => ({ returning: () => written }), returning: () => written },
            ),
        }),
        scope,
        select: (selection?: { readonly status?: object }) => ({
          from: () => ({
            where: () => {
              const result = Effect.succeed(
                selection?.status === undefined ? stateRows : [{ status: 'active', tenantId: scope.tenantId }],
              );
              return Object.assign(result, { limit: () => result });
            },
          }),
        }),
        update: () => ({ set: () => ({ where: () => ({ returning: () => written }) }) }),
      } as unknown as ScopedTransactionExecutor;
      // oxlint-enable sonarjs/no-nested-functions
      const payload = yield* Schema.decodeUnknownEffect(ApplyCommandPayloadSchema)({
        command: { _tag: 'CreateMetric', title: 'Prepared metric' },
        expectedRevision: 0,
      });
      const services = yield* getActionServiceFactory(applyCommandAction)(transaction, scope, 'test-composition').pipe(
        Effect.provideService(ContextAccess, access),
        insideDatabaseTransaction('factory-test'),
      );
      const result = yield* runActionOwnerSteps(applyCommandAction, payload, {
        actionInvocationId: '50000000-0000-4000-8000-000000000001',
        addDomainEvent: () => Effect.die('No stage transition is published by this fixture'),
        addOutboxMessage: () => Effect.void,
        compositionRevision: 'test-composition',
        recordAuditEvidence: () => Effect.void,
        recordDataAccess: () => Effect.void,
        scope,
        services,
        transaction: (step) => step(transaction).pipe(insideDatabaseTransaction('short-owner-read')),
      }).pipe(Effect.provideService(ContextAccess, access));
      expect('revision' in result ? result.revision : undefined).toBe(1);
      expect(remoteCalls).toEqual(['context']);
    }),
);
