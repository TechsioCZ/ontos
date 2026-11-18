import { Context } from 'effect';
import type { Effect } from 'effect';

import type { CallExecution, CallExecutionRequest } from './contract.ts';

/** Runs one declared read call; implemented, with its obligations, in `execution/call.ts`. */
export interface KernelCallsService {
  readonly execute: (request: CallExecutionRequest) => Effect.Effect<CallExecution>;
}

export class KernelCalls extends Context.Service<KernelCalls, KernelCallsService>()(
  '@app/core-runtime/execution/kernel-calls/KernelCalls',
) {}
