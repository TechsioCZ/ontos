// @rstest-environment happy-dom
// Tag creation sends the entered name and selected subject kinds through the owner contract.
import { acted, buttons, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Layer, Option, Predicate, Schema } from 'effect';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { applyCommandActionSchemaErrorLive } from '../../api/apply-command-action-problems.ts';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import type { ApplyCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { ApplyCommandActionApi } from '../../shared/apis/apply-command-action.ts';
import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import { TagCreatePanel } from '../../src/routes/[lang]/nastaveni/stitky/tag-create-panel.tsx';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const copy = moduleText('cs');
const commands: (typeof ApplyCommandPayloadSchema.Encoded)[] = [];
const created = Schema.decodeUnknownSync(ApplyCommandResultSchema)({
  affectedAssignments: 0,
  revision: 2,
  tagId: 'tag-new',
});
const records = Schema.decodeUnknownSync(RecordsResponseSchema)({
  assignments: [],
  canWrite: true,
  indicators: { assignmentCount: 0, tagCount: 0 },
  revision: 1,
  tags: [],
});
const OwnerActionApi = ApplyCommandActionApi.prefix('/tagging-api');
const OwnerRecordsApi = RecordsApi.prefix('/tagging-api');
const network = browserNetwork(
  shellGatewayIssuer({ tagging: '/tagging-api' }).application,
  serveApi(
    OwnerActionApi,
    HttpApiBuilder.group(OwnerActionApi, 'applyCommandAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          commands.push(payload);
          return created;
        }),
      ),
    ).pipe(Layer.provide(applyCommandActionSchemaErrorLive)),
  ),
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) => group.handle('execute', () => Effect.succeed(records))),
  ),
);

const mount = () =>
  Effect.gen(function* mountPanel() {
    const closed: string[] = [];
    yield* mountInRoute(
      <TagCreatePanel
        onClose={() => {
          closed.push('close');
        }}
      />,
      {
        path: 'nastaveni/stitky',
        url: '/cs/nastaveni/stitky',
      },
    );
    return { closed, unmount: unmountAll };
  });

const button = (name: string): HTMLButtonElement => {
  const [found] = buttons(name);
  expect(found).toBeDefined();
  return Option.getOrThrow(Option.fromUndefinedOr(found));
};

const nameField = (): HTMLInputElement =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>('input[id="tag-name"]')));

/** Types through the native input event, then leaves the field. */
const typeName = (value: string) =>
  acted(() => {
    const field = nameField();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });

/** Ticks the real checkbox through its translated label. */
const tickKind = (kind: string) =>
  acted(() => {
    const label = Option.getOrThrow(
      Option.fromUndefinedOr(
        [...document.querySelectorAll<HTMLLabelElement>('label')].find(
          (candidate) => candidate.textContent?.trim() === copy(`tagging.kinds.${kind}`),
        ),
      ),
    );
    label.click();
  });

const click = (target: HTMLElement) =>
  acted(() => {
    target.click();
  });

beforeEach(() => {
  commands.length = 0;
});

afterEach(unmountAll);

it.layer(network, { excludeTestServices: true })('tag create panel with one Save button', (suite) => {
  suite.effect('one click on Save creates the tag once and closes the panel', () =>
    Effect.gen(function* saveOnce() {
      yield* pinTestDocument;
      const view = yield* mount();
      yield* typeName('VIP klient');
      yield* tickKind('order');
      yield* click(button('Uložit'));
      yield* waitUntil(() => view.closed.length === 1);
      // A second create the click started would have reached the owner by now.
      yield* networkIdle;
      expect(commands.length).toBe(1);
      expect(Predicate.isTagged(commands[0]?.command, 'CreateTag')).toBe(true);
      expect(commands[0]?.command).toMatchObject({
        name: 'VIP klient',
        subjectKinds: ['order'],
      });
    }),
  );
});
