#!/usr/bin/env node
/** Defaults to a complete native transaction followed by ROLLBACK; --apply permanently withdraws execution. */
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Console, Effect, Layer, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';

import { CoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import {
  cancelNeverInvokedSymmyProvision,
} from '../../verticals/symmy-integration/src/administration/cancel-never-invoked-provision.ts';
import { ApplicationCompositionAuthorityAdminDatabaseLive } from '../application-composition-authority-publication.mts';

class CancellationDryRun extends Schema.TaggedError<CancellationDryRun>()('CancellationDryRun', {}) {}

const command = Command.make('cancel-never-invoked-symmy-provision', {
  apply: Flag.Boolean('apply').pipe(Flag.withDefault(false)),
  tenantId: Flag.String('tenant-id'),
  jobId: Flag.String('job-id'),
  messageId: Flag.String('message-id'),
  operator: Flag.String('operator'),
  reason: Flag.String('reason'),
}, (flags) => Effect.gen(function* cancel() {
  const { executor } = yield* CoreDatabase;
  const outcome = yield* executor.transaction((transaction) =>
    cancelNeverInvokedSymmyProvision(transaction, {
      tenantId: flags.tenantId, jobId: flags.jobId, outboxMessageId: flags.messageId,
      operatorName: flags.operator, reason: flags.reason,
    }).pipe(
      Effect.flatMap(() => flags.apply ? Effect.succeed('APPLIED') : Effect.fail(new CancellationDryRun())),
    ),
  ).pipe(
    Effect.catchTag('CancellationDryRun', () => Effect.succeed('DRY_RUN_ROLLED_BACK')),
    Effect.tapError((error) => error._tag === 'SymmyProvisionCancellationError'
      ? Console.error(`[symmy-provision-cancellation] refused: ${error.reason}`)
      : Console.error('[symmy-provision-cancellation] transaction failed; details withheld')),
  );
  yield* Console.log(
    `[symmy-provision-cancellation] ${outcome}; accepted history retained; Outbox completion remains with its native worker`,
  );
})).pipe(Command.provide(() => ApplicationCompositionAuthorityAdminDatabaseLive));

export const main = Command.run({ version: '1.0.0' })(command);

if (import.meta.main) {
  NodeRuntime.runMain(
    Layer.build(Layer.effectDiscard(main).pipe(Layer.provide(NodeServices.layer))).pipe(Effect.scoped),
    { disableErrorReporting: true },
  );
}
