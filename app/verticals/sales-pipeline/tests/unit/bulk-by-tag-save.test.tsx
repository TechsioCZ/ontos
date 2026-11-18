// @rstest-environment happy-dom
// A customer tag selects the exact opportunity IDs and revision used by the bulk stage command.
import { saveLabelsFor } from '@app/admin-ui';
import { acted, buttons, text, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import {
  RecordsApi as TagRecordsApi,
  RecordsResponseSchema as TagRecordsResponseSchema,
} from '@app/tagging/contracts/records';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Layer, Option, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'effect-rstest';
import { applyCommandActionSchemaErrorLive } from '../../api/apply-command-action-problems.ts';
import type { ApplyCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { ApplyCommandActionApi } from '../../shared/apis/apply-command-action.ts';
import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import { OpportunitySchema } from '../../shared/model/opportunity.ts';
import { BulkByTagDialog } from '../../src/routes/[lang]/prodej/prilezitosti/pipeline-bulk-by-tag.tsx';
import type { BulkByTagResult } from '../../src/routes/[lang]/prodej/prilezitosti/pipeline-bulk-by-tag.tsx';
import { mountInRoute } from '../support/module-ui.ts';

const opportunity = Schema.decodeUnknownSync(OpportunitySchema)({
  amountMinor: 0,
  createdAt: '2026-10-01T08:00:00.000Z',
  currency: 'CZK',
  expectedCloseDate: '2026-11-30',
  id: '0196a8a0-0000-7000-8000-000000000001',
  lines: [],
  partyId: '0196a8a0-0000-7000-8000-0000000000aa',
  probability: 10,
  stage: 'LEAD',
  stageHistory: [],
  title: 'Regály',
  updatedAt: '2026-10-01T08:00:00.000Z',
});
const records = Schema.decodeUnknownSync(RecordsResponseSchema)({
  actorPrincipalRef: {
    principalId: '20000000-0000-4000-8000-000000000001',
    tenantId: '20000000-0000-4000-8000-000000000002',
  },
  canWrite: true,
  indicators: {
    byStage: [],
    lostCount: 0,
    openCount: 1,
    openValueMinor: 0,
    weightedValueMinor: 0,
    winRate: null,
    wonCount: 0,
    wonValueMinor: 0,
  },
  items: [Schema.encodeSync(OpportunitySchema)(opportunity)],
  revision: 3,
});
const tagRecords = Schema.decodeUnknownSync(TagRecordsResponseSchema)({
  assignments: [
    { assignedAt: '2026-10-01T08:00:00.000Z', subject: { id: opportunity.partyId, kind: 'customer' }, tagId: 'tag-1' },
  ],
  canWrite: true,
  indicators: { assignmentCount: 1, tagCount: 1 },
  revision: 1,
  tags: [
    {
      color: 'blue',
      counts: { customer: 1, employee: 0, opportunity: 0, order: 0, product: 0 },
      createdAt: '2026-10-01T08:00:00.000Z',
      id: 'tag-1',
      name: 'Vybraní zákazníci',
      subjectKinds: ['customer'],
      updatedAt: '2026-10-01T08:00:00.000Z',
    },
  ],
});
const sent: { readonly command: (typeof ApplyCommandPayloadSchema.Encoded)['command']; readonly revision: number }[] =
  [];
const OwnerRecords = RecordsApi.prefix('/sales-pipeline-api');
const OwnerAction = ApplyCommandActionApi.prefix('/sales-pipeline-api');
const Tags = TagRecordsApi.prefix('/tagging-api');
const network = browserNetwork(
  shellGatewayIssuer({ 'sales-pipeline': '/sales-pipeline-api', tagging: '/tagging-api' }).application,
  serveApi(
    OwnerRecords,
    HttpApiBuilder.group(OwnerRecords, 'records', (g) => g.handle('execute', () => Effect.succeed(records))),
  ),
  serveApi(
    Tags,
    HttpApiBuilder.group(Tags, 'records', (g) => g.handle('execute', () => Effect.succeed(tagRecords))),
  ),
  serveApi(
    OwnerAction,
    HttpApiBuilder.group(OwnerAction, 'applyCommandAction', (g) =>
      g.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          sent.push({ command: payload.command, revision: payload.expectedRevision });
          return { opportunities: [opportunity], revision: 4 };
        }),
      ),
    ).pipe(Layer.provide(applyCommandActionSchemaErrorLive)),
  ),
);

const labels = saveLabelsFor('cs');
const copy = { stage: 'NEGOTIATION' } as const;
const button = (name: string) => Option.getOrThrow(Option.fromNullishOr(buttons(name).at(0)));
const mount = (events: string[], done: BulkByTagResult[]) =>
  mountInRoute(
    <BulkByTagDialog
      activeEmployees={[]}
      customerLabel={(partyId) => partyId}
      onDone={(result) => {
        done.push(result);
      }}
      onOpenChange={(open) => {
        events.push(open ? 'open' : 'closed');
      }}
    />,
    { path: 'prodej/prilezitosti', url: '/cs/prodej/prilezitosti' },
  );
const pickTag = () =>
  Effect.gen(function* pickTagOption() {
    yield* waitUntil(() => {
      const trigger = document.querySelector<HTMLButtonElement>('[data-scope="combobox"][data-part="trigger"]');
      return trigger !== null && !trigger.disabled;
    });
    yield* acted(() => {
      Option.getOrThrow(
        Option.fromNullOr(document.querySelector<HTMLButtonElement>('[data-scope="combobox"][data-part="trigger"]')),
      ).click();
    });
    yield* waitUntil(() =>
      [...document.querySelectorAll<HTMLElement>('[role="option"]')].some((option) =>
        option.textContent?.includes('Vybraní zákazníci'),
      ),
    );
    yield* acted(() => {
      Option.getOrThrow(
        Option.fromUndefinedOr(
          [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) =>
            option.textContent?.includes('Vybraní zákazníci'),
          ),
        ),
      ).click();
    });
    yield* waitUntil(() => text().includes(opportunity.title));
  });
const pickStage = () =>
  acted(() => {
    const select = Option.getOrThrow(
      Option.fromNullOr(document.querySelector<HTMLSelectElement>('select[name="stage"]')),
    );
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, copy.stage);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });

beforeEach(() => {
  sent.length = 0;
});
afterEach(unmountAll);

describe('bulk opportunity change by customer tag', () => {
  it.live('sends the previewed opportunity IDs, target stage and population revision', () =>
    Effect.gen(function* saveBulk() {
      yield* pinTestDocument;
      const events: string[] = [];
      const done: BulkByTagResult[] = [];
      yield* mount(events, done);

      yield* pickTag();
      yield* pickStage();
      yield* waitUntil(() => !button(labels.save).disabled);

      yield* acted(() => button(labels.save).click());
      yield* waitUntil(() => done.length === 1);
      yield* networkIdle;
      expect(sent).toEqual([
        {
          command: { _tag: 'BulkUpdateOpportunities', ids: [opportunity.id], patch: { stage: copy.stage } },
          revision: 3,
        },
      ]);
      expect(done).toHaveLength(1);
      expect(done[0]?.changed).toBe(1);
    }).pipe(Effect.provide(network)),
  );
});
