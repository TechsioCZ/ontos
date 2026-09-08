#!/usr/bin/env node
import { NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import { runUltramodernScript, ultramodernExitCode } from './shared/ultramodern-command.mts';
import { ultramodernCommandFailure } from './ultramodern-command-failure.mts';

const exit = await Effect.runPromiseExit(
  runUltramodernScript({
    command: 'migrate-strict-effect',
    directoryFailure: 'Unable to resolve the strict-Effect migration directory',
    failure: ultramodernCommandFailure,
    moduleUrl: import.meta.url,
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
process.exitCode = ultramodernExitCode(exit);
