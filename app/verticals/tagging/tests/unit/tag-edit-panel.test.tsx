// @rstest-environment happy-dom
// The tag edit panel as the user sees it: one Save button in the panel footer, the draft's status next to it, and a
// question before unsaved changes are left. Real clients, i18n and routing run against the owner HTTP contracts.
import { acted, buttons, settle, text, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
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
import { moduleText, mountInRoute } from '../support/module-ui.ts';

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
const closeLabel = moduleText('cs')('tagging.tags.form.close');

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
  it.live('typing changes only the draft: nothing is sent after a pause, a blur or unmount', () =>
    Effect.gen(function* typingSendsNothing() {
      const view = yield* mount;
      expect(buttons('Uložit')).toHaveLength(1);
      expect(button('Uložit').disabled).toBe(true);
      expect(text()).not.toMatch(/automat/iu);

      yield* typeName('VIP klient');
      expect(button('Uložit').disabled).toBe(false);
      expect(text()).toContain('Neuložené změny');
      // Longer than any debounce the panel ever had.
      yield* Effect.sleep('1 second');
      yield* settle;
      view.unmount();
      yield* settle;
      expect(commands).toHaveLength(0);
    }).pipe(Effect.provide(network)),
  );

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

  it.live('an invalid draft cannot be saved', () =>
    Effect.gen(function* invalid() {
      yield* mount;
      yield* typeName(' ');
      expect(saveState()).toBe('invalid');
      expect(button('Uložit').disabled).toBe(true);
      expect(commands).toHaveLength(0);
    }).pipe(Effect.provide(network)),
  );

  it.live('closing with unsaved changes asks; Zůstat keeps the draft, Zahodit změny closes without sending', () =>
    Effect.gen(function* leave() {
      const view = yield* mount;
      yield* typeName('VIP klient');
      yield* click(button(closeLabel));
      expect(buttons('Zahodit změny')).toHaveLength(1);
      expect(view.closed).toEqual([]);

      yield* click(button('Zůstat'));
      yield* waitUntil(() => buttons('Zůstat').length === 0);
      expect(nameField().value).toBe('VIP klient');

      yield* click(button(closeLabel));
      yield* click(button('Zahodit změny'));
      expect(view.closed).toEqual(['close']);
      expect(commands).toHaveLength(0);
    }).pipe(Effect.provide(network)),
  );

  it.live('a clean panel closes without asking', () =>
    Effect.gen(function* cleanClose() {
      const view = yield* mount;
      yield* click(button(closeLabel));
      expect(buttons('Zůstat')).toHaveLength(0);
      expect(view.closed).toEqual(['close']);
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

  it.live('a change parked for approval is sent once and never again', () =>
    Effect.gen(function* proposed() {
      const receipt = Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
        _tag: 'ActionProposalAccepted',
        expiresAt: '2026-11-10T12:00:00.000Z',
        proposalId: '60000000-0000-4000-8000-000000000001',
      });
      answer = receipt;
      yield* mount;
      yield* typeName('VIP klient');
      yield* click(button('Uložit'));
      yield* waitUntil(() => saveState() === 'proposed');
      expect(button('Uložit').disabled).toBe(true);
      yield* click(button('Uložit'));
      expect(commands).toHaveLength(1);
    }).pipe(Effect.provide(network)),
  );
});
