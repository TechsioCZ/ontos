#!/usr/bin/env node
/**
 * Settles what is left of a Symmy job whose execution delivery an operator released (outbox-dead-delivery release):
 * the worker never runs such a job again. Defaults to a complete native transaction followed by ROLLBACK; --apply
 * cancels the job's admission fence and settles every unfinished effect for good, one whose owner call committed from
 * the owner's committed reply.
 *
 *   node scripts/ops/settle-released-symmy-job.mts --tenant-id <id> --job-id <id> --message-id <job outbox message> \
 *     --operator <name> --reason <why> [--apply]
 */
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Console, Effect, Layer, Match, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';

import { CoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import { settleReleasedSymmyJob } from '../../verticals/symmy-integration/src/administration/settle-released-job.ts';
import { ApplicationCompositionAuthorityAdminDatabaseLive } from '../application-composition-authority-publication.mts';

class SettlementDryRun extends Schema.TaggedError<SettlementDryRun>()('SettlementDryRun', {}) {}

const command = Command.make(
  'settle-released-symmy-job',
  {
    apply: Flag.Boolean('apply').pipe(Flag.withDefault(false)),
    jobId: Flag.String('job-id'),
    messageId: Flag.String('message-id'),
    operator: Flag.String('operator'),
    reason: Flag.String('reason'),
    tenantId: Flag.String('tenant-id'),
  },
  (flags) =>
    Effect.gen(function* settle() {
      const { executor } = yield* CoreDatabase;
      const outcome = yield* executor
        .transaction((transaction) =>
          settleReleasedSymmyJob(transaction, {
            jobId: flags.jobId,
            operatorName: flags.operator,
            outboxMessageId: flags.messageId,
            reason: flags.reason,
            tenantId: flags.tenantId,
          }).pipe(
            Effect.tap((settled) =>
              Console.log(
                `[symmy-released-job-settlement] job ${settled.jobId}: ${String(settled.reconciled)} reconciled from ` +
                  `a committed owner call, ${String(settled.denied)} denied, ${String(settled.unsupported)} unsupported; ` +
                  `${String(settled.uncommittedInvocations)} uncommitted owner invocation(s) fenced`,
              ),
            ),
            Effect.flatMap(() => (flags.apply ? Effect.succeed('APPLIED') : Effect.fail(new SettlementDryRun()))),
          ),
        )
        .pipe(
          Effect.catchTag('SettlementDryRun', () => Effect.succeed('DRY_RUN_ROLLED_BACK')),
          Effect.tapError((error) =>
            Match.value(error).pipe(
              Match.tag('SymmyProvisionCancellationError', (problem) =>
                Console.error(`[symmy-released-job-settlement] refused: ${problem.reason}`),
              ),
              Match.orElse(() => Console.error('[symmy-released-job-settlement] transaction failed; details withheld')),
            ),
          ),
        );
      yield* Console.log(`[symmy-released-job-settlement] ${outcome}; accepted history and every Outbox row retained`);
    }),
).pipe(Command.provide(() => ApplicationCompositionAuthorityAdminDatabaseLive));

export const main = Command.run({ version: '1.0.0' })(command);

if (import.meta.main) {
  NodeRuntime.runMain(
    Layer.build(Layer.effectDiscard(main).pipe(Layer.provide(NodeServices.layer))).pipe(Effect.scoped),
    { disableErrorReporting: true },
  );
}
