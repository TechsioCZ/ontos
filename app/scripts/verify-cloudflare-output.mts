#!/usr/bin/env node
import { NodeServices } from '@effect/platform-node';
import { Effect, Schema } from 'effect';
import { runUltramodernScript, ultramodernExitCode } from './shared/ultramodern-command.mts';

class CloudflareOutputVerificationLaunchError extends Schema.TaggedError<CloudflareOutputVerificationLaunchError>()(
  'CloudflareOutputVerificationLaunchError',
  { reason: Schema.String },
) {}

const failure = (reason: string): CloudflareOutputVerificationLaunchError =>
  new CloudflareOutputVerificationLaunchError({ reason });

const exit = await Effect.runPromiseExit(
  runUltramodernScript({
    command: 'cloudflare-output-verify',
    directoryFailure: 'Unable to resolve the Cloudflare output verifier directory',
    failure,
    moduleUrl: import.meta.url,
    nodeExecutable: process.execPath,
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
process.exitCode = ultramodernExitCode(exit);
