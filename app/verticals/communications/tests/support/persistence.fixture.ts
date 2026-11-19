import { TrustedPrincipalContextSchema, loadDatabaseConnectionPair } from '@app/core-runtime';
import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { makeCoreDatabase } from '@app/core-runtime/db/client';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { Crypto, Effect, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import type { TemplateRevisionPortContract } from '../../src/services/template-revision-port.service.ts';
import { postgresTemplateRevisionPort } from '../../src/services/template-revision.service.ts';
import type { TemplateActor } from '../../src/services/template-revision-domain.service.ts';

export const nativeServices = Layer.mergeAll(NodeCrypto.layer, NodeServices.layer, Reactivity.layer);
export const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());

export const actorWith = (actionInvocationId: string, legalEntityId: string | null = null): TemplateActor => ({
  actionInvocationId,
  legalEntityId,
  principalId: '00000000-0000-4000-8000-0000000000b1',
});

const scopeFor = (tenantId: string) =>
  Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
    authContextRef: 'job:communications-template-tests:run:1',
    authMethod: 'system',
    principalId: '00000000-0000-4000-8000-0000000000b1',
    tenantId,
  }).pipe(
    Effect.map((principal) => ({ ...principal, correlationId: 'communications-template-tests' })),
    Effect.orDie,
  );

/**
 * The Communications tables as the runtime role sees them: one connection pool as `ontos_runtime`, and every program
 * runs in one Core transaction with the Tenant installed by Core's own scoped-transaction installer, so row-level
 * security and the executor the port receives are the production ones. No Core identity row is needed because the
 * template tables reference none.
 */
export const makeRuntimeDatabase = Effect.fn('CommunicationsTest.runtimeDatabase')(function* runtimeDatabase() {
  const connections = yield* loadDatabaseConnectionPair();
  const { executor } = yield* makeCoreDatabase(connections.runtime);
  const inTenant = <Value, Failure, Requirements>(
    tenantId: string,
    program: (transaction: ScopedTransactionExecutor) => Effect.Effect<Value, Failure, Requirements>,
  ) =>
    executor.transaction(
      Effect.fn('CommunicationsTest.inTenant')(function* inTenantTransaction(transaction) {
        const scoped = yield* installOperationalScope(transaction, yield* scopeFor(tenantId));
        return yield* program(scoped);
      }),
    );
  const withPort = <Value, Failure, Requirements>(
    tenantId: string,
    program: (port: TemplateRevisionPortContract) => Effect.Effect<Value, Failure, Requirements>,
  ) => inTenant(tenantId, (transaction) => program(postgresTemplateRevisionPort(transaction, { tenantId })));
  return { inTenant, withPort };
});
