// @rstest-environment happy-dom
// The bulk tag panel uses its real router, translations, combobox and generated clients.
// The owner's HTTP contracts record writes while the Shell issues gateway assertions in process.
import { saveLabelsFor } from '@app/admin-ui';
import { acted, buttons, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Layer, Option, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'effect-rstest';
import { assignTagActionSchemaErrorLive } from '../../api/assign-tag-action-problems.ts';
import { unassignTagActionSchemaErrorLive } from '../../api/unassign-tag-action-problems.ts';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import { AssignTagActionApi } from '../../shared/apis/assign-tag-action.ts';
import {
  RecordsApi,
  RecordsResponseSchema,
  SubjectIdSchema,
  SubjectSchema,
  TagSchema,
} from '../../shared/apis/records.ts';
import type { Subject, Tag, TagId } from '../../shared/apis/records.ts';
import { UnassignTagActionApi } from '../../shared/apis/unassign-tag-action.ts';
import { BulkTagDialog } from '../../src/components/tag-controls.tsx';
import { taggingI18nResources } from '../../src/tags/tag-i18n.tsx';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

interface Write {
  readonly mode: string;
  readonly subjects: readonly Subject[];
  readonly tagId: TagId;
}

const writes: Write[] = [];
const labels = saveLabelsFor('cs');
const copy = moduleText('cs', taggingI18nResources);

const vip: Tag = Schema.decodeUnknownSync(TagSchema)({
  color: 'blue',
  createdAt: '2026-10-05T10:00:00.000Z',
  id: 'tag-vip',
  name: 'VIP',
  subjectKinds: ['customer'],
  updatedAt: '2026-10-05T10:00:00.000Z',
});
const subjectIds = ['customer-1', 'customer-2'].map((id) => Schema.decodeSync(SubjectIdSchema)(id));
const records = Schema.decodeUnknownSync(RecordsResponseSchema)({
  assignments: [],
  canWrite: true,
  indicators: { assignmentCount: 0, tagCount: 1 },
  revision: 0,
  tags: [
    {
      ...Schema.encodeSync(TagSchema)(vip),
      counts: { customer: 0, employee: 0, opportunity: 0, order: 0, product: 0 },
    },
  ],
});
const applied = Schema.decodeUnknownSync(ApplyCommandResultSchema)({
  affectedAssignments: subjectIds.length,
  revision: 1,
  tagId: vip.id,
});

const OwnerRecordsApi = RecordsApi.prefix('/tagging-api');
const OwnerAssignApi = AssignTagActionApi.prefix('/tagging-api');
const OwnerUnassignApi = UnassignTagActionApi.prefix('/tagging-api');
const network = browserNetwork(
  shellGatewayIssuer({ tagging: '/tagging-api' }).application,
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) => group.handle('execute', () => Effect.succeed(records))),
  ),
  serveApi(
    OwnerAssignApi,
    HttpApiBuilder.group(OwnerAssignApi, 'assignTagAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          writes.push({
            mode: 'add',
            subjects: Schema.decodeSync(Schema.Array(SubjectSchema))(payload.command.subjects),
            tagId: Schema.decodeSync(TagSchema.fields.id)(payload.command.tagId),
          });
          return applied;
        }),
      ),
    ).pipe(Layer.provide(assignTagActionSchemaErrorLive)),
  ),
  serveApi(
    OwnerUnassignApi,
    HttpApiBuilder.group(OwnerUnassignApi, 'unassignTagAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          writes.push({
            mode: 'remove',
            subjects: Schema.decodeSync(Schema.Array(SubjectSchema))(payload.command.subjects),
            tagId: Schema.decodeSync(TagSchema.fields.id)(payload.command.tagId),
          });
          return applied;
        }),
      ),
    ).pipe(Layer.provide(unassignTagActionSchemaErrorLive)),
  ),
);

const mount = () =>
  Effect.gen(function* mountPanel() {
    const events: string[] = [];
    yield* mountInRoute(
      <BulkTagDialog
        kind="customer"
        onDone={() => {
          events.push('done');
        }}
        onOpenChange={(open) => {
          events.push(open ? 'open' : 'closed');
        }}
        open
        subjectIds={subjectIds}
      />,
      { resources: taggingI18nResources },
    );
    return { events };
  });

const button = (name: string): HTMLButtonElement => Option.getOrThrow(Option.fromNullishOr(buttons(name).at(0)));
const element = (selector: string): HTMLElement =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLElement>(selector)));
const click = (target: HTMLElement) =>
  acted(() => {
    target.click();
  });
const pickVip = () =>
  Effect.gen(function* pickTag() {
    yield* waitUntil(() => document.querySelector('[role="combobox"]') !== null);
    yield* click(button(copy('tagging.tags.filter.toggle')));
    yield* waitUntil(() =>
      [...document.querySelectorAll('[role="option"]')].some((option) => option.textContent?.trim() === vip.name),
    );
    yield* click(element(`[role="option"][data-value="${vip.id}"]`));
  });

beforeEach(() => {
  writes.length = 0;
});
afterEach(unmountAll);

describe('bulk tag panel with the shared Uložit', () => {
  it.live('picking sends nothing; one click on Uložit tags every selected subject once and closes', () =>
    Effect.gen(function* applyOnce() {
      yield* pinTestDocument;
      const view = yield* mount();
      expect(buttons(labels.save)).toHaveLength(1);
      expect(button(labels.save).disabled).toBe(true);

      yield* pickVip();
      expect(writes).toEqual([]);
      expect(button(labels.save).disabled).toBe(false);

      yield* click(button(labels.save));
      yield* waitUntil(() => view.events.includes('closed'));
      expect(writes).toEqual([
        {
          mode: 'add',
          subjects: subjectIds.map((id) => ({ id, kind: 'customer' })),
          tagId: vip.id,
        },
      ]);
      expect(view.events).toEqual(['done', 'closed']);
    }).pipe(Effect.provide(network)),
  );
});
