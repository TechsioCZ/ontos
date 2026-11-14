import { Effect } from 'effect';

import { computeCanonicalValueHash } from '../../actions/repository.ts';
import type { AccessCheckItem, AccessCheckResult, DecisionCheckPort } from '../decision/engine.ts';
import { accessDecisionUnavailable } from '../decision/errors.ts';

const keyOf = (item: AccessCheckItem) => computeCanonicalValueHash(item);

/**
 * Invocation-owned engine evidence, never a decision or a permit. Replay answers only the EXACT
 * resource/permission/subject/caveat question SpiceDB answered during preparation. The gate still
 * resolves current persisted intent and runs its normal planner/verdict inside the writer fence.
 */
export const prepareEngineEvidence = (remote: DecisionCheckPort) => {
  const answers = new Map<string, AccessCheckResult>();
  let sealed = false;
  const capture: DecisionCheckPort = {
    checkBulk: Effect.fn('AccessDecision.captureEngineEvidence')(function* captureEngineEvidence(
      items: readonly AccessCheckItem[],
    ) {
      if (sealed) {
        return yield* accessDecisionUnavailable('Prepared engine evidence has already been sealed');
      }
      const results = yield* remote.checkBulk(items);
      if (results.length !== items.length) {
        return yield* accessDecisionUnavailable('The engine returned incomplete preparation evidence');
      }
      for (const [index, item] of items.entries()) {
        const result = results[index];
        if (result === undefined || result.permissionship === 'error' || result.permissionship === 'conditional') {
          return yield* accessDecisionUnavailable('The engine could not prove this exact preparation question');
        }
        const key = keyOf(item);
        const previous = answers.get(key);
        if (previous !== undefined && previous.permissionship !== result.permissionship) {
          return yield* accessDecisionUnavailable('The engine changed its answer during preparation');
        }
        answers.set(key, Object.freeze({ permissionship: result.permissionship }));
      }
      return results;
    }),
  };
  const replay: DecisionCheckPort = {
    checkBulk: Effect.fn('AccessDecision.replayEngineEvidence')(function* replayEngineEvidence(
      items: readonly AccessCheckItem[],
    ) {
      if (!sealed) {
        return yield* accessDecisionUnavailable('Engine preparation evidence is not sealed');
      }
      const results: AccessCheckResult[] = [];
      for (const item of items) {
        const answer = answers.get(keyOf(item));
        if (answer === undefined) {
          return yield* accessDecisionUnavailable(
            'Current authority needs an engine question preparation did not prove',
          );
        }
        results.push(answer);
      }
      return results;
    }),
  };
  return Object.freeze({
    capture,
    replay,
    seal: () => {
      sealed = true;
    },
  });
};
