#!/usr/bin/env node
import { NodeServices } from '@effect/platform-node';
import { Effect, Schema } from 'effect';

import { runUltramodernScript, ultramodernExitCode } from './shared/ultramodern-command.mts';

class BackendFederationGenerationError extends Schema.TaggedError<BackendFederationGenerationError>()(
  'BackendFederationGenerationError',
  { reason: Schema.String },
) {}

const failure = (reason: string): BackendFederationGenerationError => new BackendFederationGenerationError({ reason });

const exit = await Effect.runPromiseExit(
  runUltramodernScript({
    command: 'backend-federation-generate',
    directoryFailure: 'Unable to resolve the backend-federation generator directory',
    failure,
    launchErrorDetail: (error) => `: ${error.message}`,
    moduleUrl: import.meta.url,
    nodeExecutable: process.execPath,
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
process.exitCode = ultramodernExitCode(exit);
