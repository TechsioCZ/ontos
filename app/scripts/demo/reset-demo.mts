#!/usr/bin/env node
/**
 * Sales-demo reset orchestrator (`pnpm demo:reset:sales`). Local only.
 *
 * Runs every owner's `verticals/<owner>/scripts/reset-demo.mts` in the fixed order below as a separate
 * Node process (argument `--sales-demo`) with the validated local environment plus `DEMO_RESET_PROFILE=sales`. Each owner seeds
 * only its own schema with IDs from `scripts/demo/fixture-ids.mts`. Lanes edit their own owner script;
 * only this file decides the order.
 */
import { NodeServices } from '@effect/platform-node';
import { ConfigProvider, Console, Effect, Exit, FileSystem, Layer, Path, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

import { resetChildEnvironment, resetEnvironment, validateResetEnvironment } from '../siampark/reset-configuration.mts';

class SalesDemoResetError extends Schema.TaggedError<SalesDemoResetError>()('SalesDemoResetError', {
  reason: Schema.String,
}) {}

/** Dependency order: referenced owners first, consumers of their IDs after. */
const SALES_DEMO_OWNERS = [
  'party-registry',
  'workforce',
  'merchandise',
  'tagging',
  'sales-pipeline',
  'siampark-billing-finance',
  'siampark-work',
] as const;

const ownerScript = (owner: (typeof SALES_DEMO_OWNERS)[number]) => `verticals/${owner}/scripts/reset-demo.mts`;

const main = (validateOnly: boolean) =>
  Effect.gen(function* resetSalesDemo() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* path.fromFileUrl(new URL('../..', import.meta.url));
    for (const owner of SALES_DEMO_OWNERS) {
      if (!(yield* fs.exists(path.join(root, ownerScript(owner))))) {
        return yield* new SalesDemoResetError({ reason: `Missing owner reset script: ${ownerScript(owner)}` });
      }
    }
    if (validateOnly) {
      return yield* Console.log(`Validated ${SALES_DEMO_OWNERS.length} sales-demo owner scripts; no data changed.`);
    }
    const fileProvider = yield* ConfigProvider.fromDotEnv({ path: path.join(root, '.env') });
    const provider = ConfigProvider.orElse(ConfigProvider.fromEnv(), fileProvider);
    const childEnvironment = resetChildEnvironment(yield* resetEnvironment.parse(provider));
    yield* validateResetEnvironment(childEnvironment);
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    for (const owner of SALES_DEMO_OWNERS) {
      yield* Console.log(`sales-demo reset: ${owner}`);
      const code = yield* spawner.exitCode(
        ChildProcess.make(process.execPath, [path.join(root, ownerScript(owner)), '--sales-demo'], {
          cwd: root,
          env: { ...childEnvironment, DEMO_RESET_PROFILE: 'sales', MISE_ARGV0: '' },
          stderr: 'inherit',
          stdin: 'ignore',
          stdout: 'inherit',
        }),
      );
      if (code !== ChildProcessSpawner.ExitCode(0)) {
        return yield* new SalesDemoResetError({ reason: `Owner reset failed: ${ownerScript(owner)}` });
      }
    }
    return yield* Console.log('Sales demo baseline restored.');
  });

const command = Command.make(
  'sales-demo-reset',
  { validateOnly: Flag.Boolean('validate-only').pipe(Flag.withDefault(false)) },
  ({ validateOnly }) =>
    main(validateOnly).pipe(
      Effect.tapError((failure) => Console.error(`Sales demo reset failed (${failure._tag}).`)),
      Effect.scoped,
    ),
);
const runtimeLive = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
  Layer.provide(NodeServices.layer),
);
const exit = await Effect.runPromiseExit(Effect.scoped(Layer.build(runtimeLive)));
process.exitCode = Exit.isFailure(exit) ? 1 : 0;
