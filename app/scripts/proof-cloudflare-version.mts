#!/usr/bin/env node
import { NodeServices } from '@effect/platform-node';
import { Effect, Schema } from 'effect';
import { runUltramodernScript, ultramodernExitCode } from './shared/ultramodern-command.mts';

class CloudflareProofLaunchError extends Schema.TaggedError<CloudflareProofLaunchError>()(
  'CloudflareProofLaunchError',
  { reason: Schema.String },
) {}

const failure = (reason: string): CloudflareProofLaunchError =>
  new CloudflareProofLaunchError({ reason });

const exit = await Effect.runPromiseExit(
  runUltramodernScript({
    command: 'cloudflare-proof',
    directoryFailure: 'Unable to resolve the Cloudflare proof directory',
    failure,
    moduleUrl: import.meta.url,
    nodeExecutable: process.execPath,
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
process.exitCode = ultramodernExitCode(exit);
