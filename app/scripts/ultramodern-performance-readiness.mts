#!/usr/bin/env node
import { NodeServices } from '@effect/platform-node';
import { Effect, Schema } from 'effect';
import { runUltramodernScript, ultramodernExitCode } from './shared/ultramodern-command.mts';

class PerformanceReadinessError extends Schema.TaggedError<PerformanceReadinessError>()(
  'PerformanceReadinessError',
  { reason: Schema.String },
) {}

const failure = (reason: string): PerformanceReadinessError =>
  new PerformanceReadinessError({ reason });

const exit = await Effect.runPromiseExit(
  runUltramodernScript({
    command: 'performance-readiness',
    directoryFailure: 'Unable to resolve the performance-readiness directory',
    failure,
    moduleUrl: import.meta.url,
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
process.exitCode = ultramodernExitCode(exit);
