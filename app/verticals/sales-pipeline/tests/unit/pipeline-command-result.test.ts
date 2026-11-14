import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { Effect, Schema } from 'effect';
import { beforeEach, expect, it, rstest } from 'effect-rstest';
import { ApplyCommandResultSchema, SalesPipelineCommandSchema } from '../../shared/actions/apply-command.ts';
import {
  applyPipelineCommand,
  applyPipelineCommandIfUnchanged,
} from '../../src/routes/[lang]/prodej/prilezitosti/pipeline-api.ts';
import { opportunitySaveResult } from '../../src/routes/[lang]/prodej/prilezitosti/opportunity-draft.ts';

const mocks = rstest.hoisted(() => ({ command: rstest.fn(), invalidate: rstest.fn(), records: rstest.fn() }));
rstest.mock('../../src/api/apply-command-action-client.ts', () => ({ executeApplyCommand: mocks.command }));
rstest.mock('../../src/api/records-client.ts', () => ({ executeRecords: mocks.records }));
rstest.mock('../../src/routes/[lang]/prodej/prilezitosti/pipeline-related.ts', () => ({
  opportunityRelatedData: { invalidate: mocks.invalidate },
}));
const command = Schema.decodeUnknownSync(SalesPipelineCommandSchema)({
  _tag: 'ArchiveOpportunity',
  id: '10000000-0000-4000-8000-000000000001',
});
const proposal = Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
  _tag: 'ActionProposalAccepted',
  expiresAt: '2026-11-07T12:00:00Z',
  proposalId: '20000000-0000-4000-8000-000000000001',
});
beforeEach(() => {
  rstest.resetAllMocks();
});
it.effect('a parked proposal never reaches committed command callbacks or revision retries', () =>
  Effect.gen(function* pending() {
    mocks.command.mockReturnValue(Effect.succeed(proposal));
    let committed = false;
    const receipt = yield* applyPipelineCommand(command, 7).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          committed = true;
        }),
      ),
      Effect.flip,
    );
    expect(receipt).toBe(proposal);
    expect(committed).toBe(false);
    expect(mocks.command).toHaveBeenCalledTimes(1);
    expect(mocks.records).not.toHaveBeenCalled();
  }),
);
it.effect('a parked guarded save reports proposed rather than adopting a fabricated revision', () =>
  Effect.gen(function* pendingSave() {
    mocks.command.mockReturnValue(Effect.succeed(proposal));
    const result = yield* opportunitySaveResult(applyPipelineCommandIfUnchanged(command, 7, () => true));
    expect(result).toBe('proposed');
    expect(mocks.command).toHaveBeenCalledTimes(1);
    expect(mocks.records).not.toHaveBeenCalled();
  }),
);
it.effect('only a decoded committed owner result publishes its actual revision', () =>
  Effect.gen(function* committed() {
    const result = yield* Schema.decodeUnknownEffect(ApplyCommandResultSchema)({ opportunities: [], revision: 8 });
    mocks.command.mockReturnValue(Effect.succeed(result));
    expect(yield* applyPipelineCommand(command, 7)).toBe(result);
    expect(mocks.command).toHaveBeenCalledTimes(1);
  }),
);
