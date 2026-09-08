#!/usr/bin/env node
import { NodeServices } from '@effect/platform-node';
import { Effect, Schema } from 'effect';
import { runUltramodernScript, ultramodernExitCode } from './shared/ultramodern-command.mts';

class StrictEffectMigrationError extends Schema.TaggedError<StrictEffectMigrationError>()(
  'StrictEffectMigrationError',
  { reason: Schema.String },
) {}

const failure = (reason: string): StrictEffectMigrationError =>
  new StrictEffectMigrationError({ reason });

const exit = await Effect.runPromiseExit(
  runUltramodernScript({
    command: 'migrate-strict-effect',
    directoryFailure: 'Unable to resolve the strict-Effect migration directory',
    failure,
    moduleUrl: import.meta.url,
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
process.exitCode = ultramodernExitCode(exit);
