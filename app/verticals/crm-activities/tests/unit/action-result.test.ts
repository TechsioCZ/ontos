import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { committedResult, pendingProposalMessage } from '../../src/api/action-result.ts';

const receipt = Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
  _tag: 'ActionProposalAccepted',
  expiresAt: '2026-11-10T12:00:00.000Z',
  proposalId: '60000000-0000-4000-8000-000000000001',
});
it.effect(
  'a commit-only UI retains the exact canonical pending receipt instead of inventing a committed revision',
  () =>
    Effect.gen(function* pending() {
      const failure = yield* committedResult(receipt).pipe(Effect.flip);
      expect(failure).toBe(receipt);
      expect(pendingProposalMessage(failure)).toBeDefined();
      expect(pendingProposalMessage(failure)).not.toContain(receipt.proposalId);
      expect(pendingProposalMessage(failure)).not.toContain('2026-11-10T12:00:00.000Z');
      expect('revision' in failure).toBe(false);
    }),
);
it.effect('an actual committed result retains its revision and identity', () =>
  Effect.gen(function* committed() {
    const result = { revision: 3 };
    expect(yield* committedResult(result)).toBe(result);
    expect(pendingProposalMessage(result)).toBeUndefined();
  }),
);
