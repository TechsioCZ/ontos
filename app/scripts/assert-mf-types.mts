#!/usr/bin/env node
import { NodeServices } from '@effect/platform-node';
import { Effect, Schema } from 'effect';
import { runUltramodernScript, ultramodernExitCode } from './shared/ultramodern-command.mts';

class MfTypesAssertionError extends Schema.TaggedError<MfTypesAssertionError>()(
  'MfTypesAssertionError',
  { reason: Schema.String },
) {}

const failure = (reason: string): MfTypesAssertionError => new MfTypesAssertionError({ reason });

const exit = await Effect.runPromiseExit(
  runUltramodernScript({
    command: 'mf-types',
    directoryFailure: 'Unable to resolve the MF types wrapper directory',
    failure,
    moduleUrl: import.meta.url,
    nodeExecutable: process.execPath,
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
process.exitCode = ultramodernExitCode(exit);
