#!/usr/bin/env node
import { NodeServices } from '@effect/platform-node';
import { Effect, Schema } from 'effect';

import {
  runUltramodernScript,
  ultramodernExitCode,
} from './shared/ultramodern-command.mts';

class PublicSurfaceGenerationError extends Schema.TaggedError<PublicSurfaceGenerationError>()(
  'PublicSurfaceGenerationError',
  { reason: Schema.String }
) {}

const failure = (reason: string): PublicSurfaceGenerationError =>
  new PublicSurfaceGenerationError({ reason });

const exit = await Effect.runPromiseExit(
  runUltramodernScript({
    command: 'public-surface',
    directoryFailure:
      'Unable to resolve the public-surface generator directory',
    failure,
    launchErrorDetail: (error) => `: ${error.message}`,
    moduleUrl: import.meta.url,
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)
);
process.exitCode = ultramodernExitCode(exit);
