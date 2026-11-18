// @rstest-environment happy-dom
// Tag editing maps the patch and refuses to overwrite an independently changed tag.
import { acted, buttons, text, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import type { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { DateTime, Effect, Layer, Option, Predicate, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'effect-rstest';
import { updateTagActionSchemaErrorLive } from '../../api/update-tag-action-problems.ts';
import type { ApplyCommandResult, UpdateTagPayloadSchema } from '../../shared/actions/apply-command.ts';
import { RecordsApi, TagIdSchema } from '../../shared/apis/records.ts';
import type { RecordsRequest, RecordsResponse, TagWithCounts } from '../../shared/apis/records.ts';
import { UpdateTagActionApi } from '../../shared/apis/update-tag-action.ts';
import { TagEditPanel } from '../../src/routes/[lang]/nastaveni/stitky/tag-edit-panel.tsx';
import { mountInRoute } from '../support/module-ui.ts';

const now = DateTime.makeUnsafe('2026-11-01T10:00:00Z');
const vip: TagWithCounts = {
  color: 'green',
  counts: { customer: 0, employee: 0, opportunity: 0, order: 0, product: 0 },
  createdAt: now,
  id: Schema.decodeUnknownSync(TagIdSchema)('tag-vip'),
  name: 'VIP',
  subjectKinds: ['order', 'customer'],
  updatedAt: now,
};

const commands: (typeof UpdateTagPayloadSchema.Encoded)[] = [];
const reads: RecordsRequest[] = [];
const records: RecordsResponse = {
  assignments: [],
  canWrite: true,
  indicators: { assignmentCount: 0, tagCount: 1 },
  revision: 4,
  tags: [vip],
};
let recordsAnswer = records;
const saved: ApplyCommandResult = { affectedAssignments: 0, revision: 5, tagId: vip.id };
let answer: ApplyCommandResult | typeof ActionProposalAcceptedSchema.Type = saved;
const OwnerRecordsApi = RecordsApi.prefix('/tagging-api');
const OwnerActionApi = UpdateTagActionApi.prefix('/tagging-api');
const network = browserNetwork(
  shellGatewayIssuer({ tagging: '/tagging-api' }).application,
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          reads.push(payload);
          return recordsAnswer;
        }),
      ),
    ),
  ),
  serveApi(
    OwnerActionApi,
    HttpApiBuilder.group(OwnerActionApi, 'updateTagAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          commands.push(payload);
          return answer;
        }),
      ),
    ).pipe(Layer.provide(updateTagActionSchemaErrorLive)),
  ),
);
const mount = Effect.gen(function* mountPanel() {
  yield* pinTestDocument;
  const closed: string[] = [];
  yield* mountInRoute(
    <TagEditPanel
      onClose={() => {
        closed.push('close');
      }}
      tag={vip}
    />,
    { path: 'nastaveni/stitky', url: '/cs/nastaveni/stitky' },
  );
  return { closed, unmount: unmountAll };
});

const button = (name: string): HTMLButtonElement => {
  const [found] = buttons(name);
  expect(found).toBeDefined();
  return found ?? document.createElement('button');
};

const nameField = (): HTMLInputElement =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>('input[id="tag-name"]')));

/** Types like a user: React sees a native input event, then the field loses focus. */
const typeName = (value: string) =>
  acted(() => {
    const field = nameField();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });

const click = (target: HTMLElement) => acted(() => target.click());

const saveState = () => document.querySelector<HTMLElement>('[data-save-state]')?.dataset.saveState;

beforeEach(() => {
  commands.length = 0;
  reads.length = 0;
  recordsAnswer = records;
  answer = saved;
});

afterEach(unmountAll);

describe('tag edit panel with one Save button', () => {
  it.live('one click on Save sends one update and shows it saved', () =>
    Effect.gen(function* saveOnce() {
      yield* mount;
      yield* typeName('VIP klient');
      yield* click(button('Uložit'));
      yield* waitUntil(() => text().includes('Uloženo'));
      expect(commands).toHaveLength(1);
      expect(Predicate.isTagged(commands[0]?.command, 'UpdateTag')).toBe(true);
      expect(commands[0]?.command).toMatchObject({
        patch: { name: 'VIP klient' },
      });
      expect(button('Uložit').disabled).toBe(true);
    }).pipe(Effect.provide(network)),
  );

  it.live('a tag someone else changed ends in a conflict, not an overwrite', () =>
    Effect.gen(function* conflict() {
      recordsAnswer = { ...records, tags: [{ ...vip, name: 'VIP změněný někým jiným' }] };
      yield* mount;
      yield* typeName('VIP klient');
      yield* click(button('Uložit'));
      yield* waitUntil(() => saveState() === 'conflict');
      expect(buttons('Načíst aktuální verzi')).toHaveLength(1);
      expect(reads).toHaveLength(1);
      expect(commands).toHaveLength(0);
    }).pipe(Effect.provide(network)),
  );
});
