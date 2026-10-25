import { makeEffectDrizzleAuthAdapter } from '@app/better-auth-effect-drizzle/server';
import { AgentProposalQueueModuleReview, ContextAccess, ReadRuntime } from '@app/core-runtime';
import type { OperationalScopeRequest } from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { DateTime, Effect, Layer } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';

import { IdentityAdministrationDeniedAuditLive } from '../../../../packages/core-runtime/src/auth/identity-administration-audit-denied.ts';
import { AgentProposalCommandPreparationLive } from '../../../../packages/core-runtime/src/auth/agent-proposal-command-preparation.ts';
import { ActionAuthority } from '../../../../packages/core-runtime/src/permissions/action-authority.ts';
import { CoreDatabase } from '../../../../packages/core-runtime/src/db/client.ts';
import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import { OperationalScopeResolverLive } from '../../../../packages/core-runtime/src/operations/context.ts';
import { scriptedPgClientLayer } from '../../../../packages/core-runtime/src/testing/scripted-pg-client.ts';
import { testSqlConnection } from '../../../../packages/core-runtime/tests/support/sql-connection.ts';
import { AuthDatabase } from '../../api/auth/db/client.ts';
import { authDatabaseSchema, authRelations } from '../../api/auth/db/schema.ts';
import {
  BetterAuthStaffRoleTemplateAccountProviderLive,
  StaffAccountDirectoryLive,
} from '../../api/auth/db/staff-account-directory-live.ts';
import type { DemoAccountCaller } from '../../api/auth/demo-accounts.ts';
import { outboxWorkerCompositionLayer } from '../../../../packages/core-runtime/tests/support/outbox-worker-composition.ts';

/** Genuine native services for existing consumer-isolation tests; their module replacements must prevent identity IO. */
export const nativeDemoAccountTestServices = Effect.fn('NativeDemoAccountTestServices.make')(
  function* nativeDemoAccountTestServices(
    caller: DemoAccountCaller,
    transport: OperationalScopeRequest,
    contextAccess: (typeof ContextAccess)['Service'],
  ) {
    const driver = scriptedPgClientLayer(
      Effect.succeed(testSqlConnection(() => Effect.die('Unexpected identity SQL'))),
    ).pipe(Layer.provideMerge(Reactivity.layer));
    const coreExecutor = yield* makeWithDefaults({ relations: coreRelations }).pipe(Effect.provide(driver));
    const authExecutor = yield* makeWithDefaults({ relations: authRelations }).pipe(Effect.provide(driver));
    const core = Layer.succeed(CoreDatabase, { executor: coreExecutor });
    const access = Layer.succeed(ContextAccess, contextAccess);
    const resolver = OperationalScopeResolverLive.pipe(Layer.provide(Layer.merge(core, access)));
    const deniedAudit = IdentityAdministrationDeniedAuditLive.pipe(
      Layer.provide(Layer.mergeAll(core, access, resolver)),
    );
    const adapter = yield* makeEffectDrizzleAuthAdapter(authExecutor, authDatabaseSchema);
    const auth = Layer.succeed(AuthDatabase, { adapter, executor: authExecutor });
    const directory = StaffAccountDirectoryLive.pipe(Layer.provide(auth));
    const provider = BetterAuthStaffRoleTemplateAccountProviderLive.pipe(Layer.provide(directory));
    const reads = yield* makeReadTestHarness({
      executeOwnerQuery: () => Effect.die('Unexpected identity Read'),
      operationTime: DateTime.toDateUtc(DateTime.makeUnsafe('2026-10-25T12:00:00.000Z')),
      scope: { ...caller.principal, correlationId: transport.correlationId },
    });
    const active = outboxWorkerCompositionLayer();
    const authority = Layer.succeed(ActionAuthority, {
      checkActionAuthorities: () => Effect.die('Unexpected business Action authority check'),
      checkActionProposalPermission: () => Effect.die('Unexpected business proposal authority check'),
    });
    const preparation = AgentProposalCommandPreparationLive.pipe(
      Layer.provide(Layer.mergeAll(core, access, active, authority)),
    );
    // Lifecycle administration must never use module-private visibility as a permission substitute.
    const review = Layer.succeed(AgentProposalQueueModuleReview, {
      review: () => Effect.die('Unexpected private module review'),
    });
    return Layer.mergeAll(
      deniedAudit,
      provider,
      preparation,
      authority,
      active,
      review,
      Layer.succeed(ReadRuntime, reads.runtime),
    );
  },
);
