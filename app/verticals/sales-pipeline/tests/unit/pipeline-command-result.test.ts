// @rstest-environment happy-dom
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Layer, Schema } from 'effect';
import { beforeEach, expect, it } from 'effect-rstest';
import { applyCommandActionSchemaErrorLive } from '../../api/apply-command-action-problems.ts';
import { SalesPipelineCommandSchema } from '../../shared/actions/apply-command.ts';
import type { ApplyCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { ApplyCommandActionApi } from '../../shared/apis/apply-command-action.ts';
import { RecordsApi } from '../../shared/apis/records.ts';
import type { RecordsRequest } from '../../shared/apis/records.ts';
import {
  applyPipelineCommand,
  applyPipelineCommandIfUnchanged,
} from '../../src/routes/[lang]/prodej/prilezitosti/pipeline-api.ts';
import { opportunitySaveResult } from '../../src/routes/[lang]/prodej/prilezitosti/opportunity-draft.ts';

const command = Schema.decodeUnknownSync(SalesPipelineCommandSchema)({
  _tag: 'ArchiveOpportunity',
  id: '10000000-0000-4000-8000-000000000001',
});
const proposal = Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
  _tag: 'ActionProposalAccepted',
  expiresAt: '2026-11-07T12:00:00Z',
  proposalId: '20000000-0000-4000-8000-000000000001',
});

const commands: (typeof ApplyCommandPayloadSchema.Encoded)[] = [];
const reads: RecordsRequest[] = [];
const OwnerActionApi = ApplyCommandActionApi.prefix('/sales-pipeline-api');
const OwnerRecordsApi = RecordsApi.prefix('/sales-pipeline-api');
const network = browserNetwork(
  shellGatewayIssuer({ 'sales-pipeline': '/sales-pipeline-api' }).application,
  serveApi(
    OwnerActionApi,
    HttpApiBuilder.group(OwnerActionApi, 'applyCommandAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          commands.push(payload);
          return proposal;
        }),
      ),
    ).pipe(Layer.provide(applyCommandActionSchemaErrorLive)),
  ),
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.gen(function* unexpectedRevisionRead() {
          reads.push(payload);
          return yield* Effect.die('A parked proposal must not read a revision for retry.');
        }),
      ),
    ),
  ),
);

beforeEach(() => {
  commands.length = 0;
  reads.length = 0;
});
it.live('a parked proposal never reaches committed command callbacks or revision retries', () =>
  Effect.gen(function* pending() {
    yield* pinTestDocument;
    let committed = false;
    const receipt = yield* applyPipelineCommand(command, 7).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          committed = true;
        }),
      ),
      Effect.flip,
    );
    expect(receipt).toStrictEqual(proposal);
    expect(committed).toBe(false);
    expect(commands).toHaveLength(1);
    expect(reads).toEqual([]);
  }).pipe(Effect.provide(network)),
);
it.live('a parked guarded save reports proposed rather than adopting a fabricated revision', () =>
  Effect.gen(function* pendingSave() {
    yield* pinTestDocument;
    const result = yield* opportunitySaveResult(applyPipelineCommandIfUnchanged(command, 7, () => true));
    expect(result).toBe('proposed');
    expect(commands).toHaveLength(1);
    expect(reads).toEqual([]);
  }).pipe(Effect.provide(network)),
);
