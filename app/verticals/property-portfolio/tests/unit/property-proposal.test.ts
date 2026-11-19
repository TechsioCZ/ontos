// @rstest-environment happy-dom
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import type { ActionProposalAccepted } from '@app/core-runtime/http/action-proposal';
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
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import type { PropertyCommand } from '../../shared/actions/apply-command.ts';
import {
  ApplyCommandActionApi,
  ApplyCommandActionConflictProblemSchema,
} from '../../shared/apis/apply-command-action.ts';
import type { ApplyCommandPayloadSchema } from '../../shared/apis/apply-command-action.ts';
import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import { savePropertyEdit } from '../../src/routes/[lang]/nemovitosti/use-property-editor.ts';

const tenantId = '70000000-0000-4000-8000-000000000020';
const unitRef = {
  moduleId: 'property.portfolio',
  resourceId: '76000000-0000-4000-8000-000000000002',
  resourceType: 'property.portfolio.unit',
  tenantId,
} as const;
const command: PropertyCommand = { _tag: 'UpdateUnit', name: 'Second Floor', note: null, unitRef };
const proposal = Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
  _tag: 'ActionProposalAccepted',
  expiresAt: '2026-11-14T10:00:00.000Z',
  proposalId: '77777777-7777-4777-8777-777777777777',
});
const conflict = Schema.decodeUnknownSync(ApplyCommandActionConflictProblemSchema)({
  _tag: 'ApplyCommandActionConflictProblem',
  code: 'property_conflict',
  detail: 'Nemovitosti se mezitím změnily.',
  status: 409,
  title: 'Konflikt',
  type: 'about:blank',
});
const committed = Schema.decodeUnknownSync(ApplyCommandResultSchema)({ resourceRef: unitRef, revision: 5 });
const freshRecords = Schema.decodeUnknownSync(RecordsResponseSchema)({
  assets: [],
  properties: [],
  revision: 6,
  units: [],
});
const commands: (typeof ApplyCommandPayloadSchema.Encoded)[] = [];
let answer: Effect.Effect<
  ActionProposalAccepted | typeof ApplyCommandResultSchema.Type,
  typeof ApplyCommandActionConflictProblemSchema.Type
> = Effect.succeed(proposal);

const OwnerActionApi = ApplyCommandActionApi.prefix('/property-portfolio-api');
const OwnerRecordsApi = RecordsApi.prefix('/property-portfolio-api');
const network = browserNetwork(
  shellGatewayIssuer({ 'property-portfolio': '/property-portfolio-api' }).application,
  serveApi(
    OwnerActionApi,
    HttpApiBuilder.group(OwnerActionApi, 'applyCommandAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          commands.push(payload);
          return answer;
        }),
      ),
    ).pipe(Layer.provide(applyCommandActionSchemaErrorLive)),
  ),
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', () => Effect.succeed(freshRecords)),
    ),
  ),
);

beforeEach(() => {
  commands.length = 0;
  answer = Effect.succeed(proposal);
});

it.layer(network, { excludeTestServices: true })('saving a property edit', (suite) => {
  suite.effect('keeps an edit parked for approval unsaved and reports the proposal', () =>
    Effect.gen(function* parked() {
      yield* pinTestDocument;
      const reported: ActionProposalAccepted[] = [];
      const result = yield* savePropertyEdit(
        command,
        4,
        () => true,
        (value) => {
          reported.push(value);
        },
      );
      expect(result).toBe('proposed');
      expect(reported).toEqual([proposal]);
      expect(commands).toHaveLength(1);
    }),
  );

  suite.effect('adopts the committed revision of an edit without reporting a proposal', () =>
    Effect.gen(function* committedEdit() {
      yield* pinTestDocument;
      answer = Effect.succeed(committed);
      const reported: ActionProposalAccepted[] = [];
      const result = yield* savePropertyEdit(
        command,
        4,
        () => true,
        (value) => {
          reported.push(value);
        },
      );
      expect(result).toBe(5);
      expect(reported).toEqual([]);
    }),
  );

  suite.effect('treats a resend after a register race that is parked for approval as not saved', () =>
    Effect.gen(function* raced() {
      yield* pinTestDocument;
      answer = Effect.suspend(() => (commands.length === 1 ? Effect.fail(conflict) : Effect.succeed(proposal)));
      const reported: ActionProposalAccepted[] = [];
      const result = yield* savePropertyEdit(
        command,
        4,
        () => true,
        (value) => {
          reported.push(value);
        },
      );
      expect(result).toBe('proposed');
      expect(reported).toEqual([proposal]);
      expect(commands).toHaveLength(2);
    }),
  );
});
