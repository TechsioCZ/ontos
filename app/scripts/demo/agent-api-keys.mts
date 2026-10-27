import { randomUUID } from 'node:crypto';
import { NodeServices } from '@effect/platform-node';
import { Console, Effect, Redacted } from 'effect';
import { Command, Flag } from 'effect/cli';

import { IdentityLifecycle } from '../../apps/shell-super-app/api/auth/identity-lifecycle.ts';
import { AgentProfileOperatorLive, authenticateAgentProfileOperator } from './agent-profile-operator.mts';
import { AgentProfileSetupError } from './agent-profile-setup.mts';

const targetFlags = {
  company: Flag.String('company'),
  idempotencyKey: Flag.String('idempotency-key'),
  principal: Flag.String('principal'),
};
const issue = Command.make('issue', { ...targetFlags, name: Flag.String('name') }, (input) =>
  Effect.scoped(
    Effect.gen(function* issueAgentKey() {
      // A one-time secret may be shown in the operator's terminal, never redirected into an environment file or log.
      if (!process.stdout.isTTY) {
        return yield* new AgentProfileSetupError({
          reason: 'Issue requires an interactive terminal for the one-time secret',
        });
      }
      const operator = yield* Effect.acquireRelease(authenticateAgentProfileOperator, (session) =>
        session.close.pipe(Effect.ignore),
      );
      const service = yield* IdentityLifecycle;
      const result = yield* service.issue({
        correlationId: randomUUID(),
        idempotencyKey: input.idempotencyKey,
        managedPrincipalId: input.principal,
        managedScope: 'company-agent',
        name: input.name,
        principal: { ...operator.principal, legalEntityId: input.company },
        requestHeaders: operator.requestHeaders,
      });
      yield* Console.log(
        `Binding ${result.authBindingId}; cleanup pending: ${result.cleanupPending}. Secret is shown once; it is not saved:`,
      );
      yield* Console.log(Redacted.value(result.secret));
      return yield* Effect.void;
    }),
  ).pipe(
    // oxlint-disable-next-line effect-native/no-effect-provide-in-library -- Executable subcommand composition root; --help acquires no database services.
    Effect.provide(AgentProfileOperatorLive),
  ),
);
const revoke = Command.make(
  'revoke',
  {
    ...targetFlags,
    binding: Flag.String('binding'),
    expectedStatus: Flag.Literals('expected-status', ['active', 'disabled']),
    reason: Flag.String('reason'),
  },
  (input) =>
    Effect.scoped(
      Effect.gen(function* revokeAgentKey() {
        const operator = yield* Effect.acquireRelease(authenticateAgentProfileOperator, (session) =>
          session.close.pipe(Effect.ignore),
        );
        const service = yield* IdentityLifecycle;
        const result = yield* service.setStatus({
          authBindingId: input.binding,
          correlationId: randomUUID(),
          expectedStatus: input.expectedStatus,
          idempotencyKey: input.idempotencyKey,
          managedPrincipalId: input.principal,
          managedScope: 'company-agent',
          newStatus: 'revoked',
          principal: { ...operator.principal, legalEntityId: input.company },
          reason: input.reason,
        });
        yield* Console.log(
          `Binding ${result.authBindingId} revoked; provider cleanup pending: ${result.cleanupPending}.`,
        );
      }),
    ).pipe(
      // oxlint-disable-next-line effect-native/no-effect-provide-in-library -- Executable subcommand composition root; --help acquires no database services.
      Effect.provide(AgentProfileOperatorLive),
    ),
);
const command = Command.make('agent-api-keys').pipe(Command.withSubcommands([issue, revoke]));
if (import.meta.main) {
  await Effect.runPromise(Command.run(command, { version: '1.0.0' }).pipe(Effect.provide(NodeServices.layer)));
}
