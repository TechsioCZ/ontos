#!/usr/bin/env node
import { NodeServices } from '@effect/platform-node';
import { Effect, Schema } from 'effect';
import { runUltramodernScript, ultramodernExitCode } from './shared/ultramodern-command.mts';

class UltramodernTypecheckError extends Schema.TaggedError<UltramodernTypecheckError>()(
  'UltramodernTypecheckError',
  { reason: Schema.String },
) {}

const failure = (reason: string): UltramodernTypecheckError =>
  new UltramodernTypecheckError({ reason });

const exit = await Effect.runPromiseExit(
  runUltramodernScript({
    command: 'typecheck',
    directoryFailure: 'Unable to resolve the typecheck wrapper directory',
    failure,
    moduleUrl: import.meta.url,
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
process.exitCode = ultramodernExitCode(exit);
