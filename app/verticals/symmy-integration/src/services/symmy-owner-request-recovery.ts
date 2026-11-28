import { Effect, Option } from 'effect';

import type { SymmyEffectAdapterInput, SymmyOriginalEffectRecovery } from './symmy-effect-adapters.service.ts';
import type { SymmyJobWorkerError } from './symmy-job-worker-error.ts';

type OriginalOwnerAttempt =
  | SymmyOriginalEffectRecovery
  | {
      readonly invocationId: string;
      readonly sourceEffectOutcome: 'changed' | 'unchanged' | 'rejected' | undefined;
      readonly status: 'committed';
    };

type FencedDenial = Extract<SymmyOriginalEffectRecovery, { readonly status: 'settled' }>;
const classifyOriginal = (
  input: SymmyEffectAdapterInput,
  original: {
    readonly actionInvocationId: string;
    readonly sourceEffectOutcome?: 'changed' | 'unchanged' | 'rejected';
    readonly status: string;
  },
  fencedDenial?: FencedDenial,
): OriginalOwnerAttempt => {
  const { actionInvocationId, sourceEffectOutcome, status } = original;
  const { originalInvocationId } = input;
  if (originalInvocationId !== undefined && originalInvocationId !== actionInvocationId) {
    return { status: 'unavailable' };
  }
  if (status === 'rejected' && input.originalOwnerReceipt === undefined) {
    return fencedDenial ?? { status: 'unavailable' };
  }
  if (status === 'succeeded') {
    return { invocationId: actionInvocationId, sourceEffectOutcome, status: 'committed' };
  }
  return {
    status:
      (status === 'received' || status === 'running') &&
      input.canExecuteNewEffects &&
      input.originalOwnerReceipt === undefined
        ? 'retry_original_key'
        : 'unavailable',
  };
};

/** Determine whether the worker can reconcile the exact write or re-enter Core with the same request. */
export const readOriginalOwnerAttempt = Effect.fn('SymmyOwnerRequest.readOriginalAttempt')(
  function* readOriginalOwnerAttempt(
    input: SymmyEffectAdapterInput,
    fencedDenial?: FencedDenial,
  ): Effect.fn.Return<OriginalOwnerAttempt, SymmyJobWorkerError> {
    const { originalAuthContextRef, originalExecutorPrincipalId, originalInvocationId, originalRequestHash } = input;
    const hasAcknowledgement = originalInvocationId !== undefined || input.originalOwnerReceipt !== undefined;
    if (originalRequestHash === undefined && originalAuthContextRef === undefined && !hasAcknowledgement) {
      // Before the complete tuple was pinned, all adapter versions stopped short of the owner call.
      if (!input.canExecuteNewEffects) {
        // A reclaimed claim has a new token/version. An older worker can no longer pin its first request.
        return fencedDenial ?? { status: 'unavailable' };
      }
      return { status: originalExecutorPrincipalId === undefined ? 'not_committed' : 'retry_original_key' };
    }
    if (
      originalExecutorPrincipalId === undefined ||
      originalRequestHash === undefined ||
      originalAuthContextRef === undefined
    ) {
      return { status: 'unavailable' };
    }
    const original = yield* input.readOriginalActionInvocation({
      actionKey: input.effect.ref.operation.entrypointKey,
      idempotencyKey: input.effect.ref.effectId,
      originalPrincipalId: originalExecutorPrincipalId,
      requestHash: originalRequestHash,
    });
    if (Option.isNone(original)) {
      return { status: !hasAcknowledgement && input.canExecuteNewEffects ? 'retry_original_key' : 'unavailable' };
    }
    return classifyOriginal(input, original.value, fencedDenial);
  },
);
