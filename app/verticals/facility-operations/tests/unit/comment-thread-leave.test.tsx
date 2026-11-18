// @rstest-environment happy-dom
// Typed comment text participates in the real router's leave guard; saving posts through the owner's HTTP contract.
import { saveLabelsFor } from '@app/admin-ui';
import { acted, buttons, text, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Layer, Option, Schema } from 'effect';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { applyCommandActionSchemaErrorLive } from '../../api/apply-command-action-problems.ts';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import type { ApplyCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { ApplyCommandActionApi } from '../../shared/apis/apply-command-action.ts';
import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import { CommentSchema } from '../../shared/domain/documents.ts';
import type { CommentRecord } from '../../shared/domain/documents.ts';
import { CommentThread } from '../../src/ui/comment-thread.tsx';
import { agendaRecordsData } from '../../src/ui/use-agenda.ts';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const labels = saveLabelsFor('cs');
const czech = moduleText('cs');
const editLabel = czech('facility-operations.documents.comments.edit');
const cancelLabel = czech('facility-operations.documents.comments.cancel');
const editor = `textarea[aria-label="${editLabel}"]`;
const composer = 'textarea';
const asked = () => text().includes(labels.leaveDescription);
const subject = { id: 'property-1', kind: 'property', label: 'Rezidence' };
const actor = { principalId: '72000000-0000-4000-8000-000000000021', tenantId: '70000000-0000-4000-8000-000000000020' };
const mine = Schema.decodeUnknownSync(CommentSchema)({
  body: 'Původní znění',
  createdAt: '2026-10-20T08:00:00Z',
  createdBy: actor,
  edits: [],
  id: 'comment-1',
  subject,
  updatedAt: '2026-10-20T08:00:00Z',
  updatedBy: actor,
});
const comments: CommentRecord[] = [];
const commands: (typeof ApplyCommandPayloadSchema.Encoded)['command'][] = [];
const records = () =>
  Schema.decodeUnknownSync(RecordsResponseSchema)({
    access: [{ agenda: 'documents', canRead: true, canWrite: true }],
    actorPrincipalRef: actor,
    agendas: {
      documents: {
        canWrite: true,
        revision: 1,
        state: { comments: comments.map((comment) => Schema.encodeSync(CommentSchema)(comment)), documents: [] },
        updatedAt: '2026-10-20T08:00:00Z',
      },
    },
  });
const posted = Schema.decodeUnknownSync(ApplyCommandResultSchema)({ entityIds: [], revision: 2 });
const OwnerRecordsApi = RecordsApi.prefix('/facility-operations-api');
const OwnerActionApi = ApplyCommandActionApi.prefix('/facility-operations-api');
const network = browserNetwork(
  shellGatewayIssuer({ 'facility-operations': '/facility-operations-api' }).application,
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) => group.handle('execute', () => Effect.sync(records))),
  ),
  serveApi(
    OwnerActionApi,
    HttpApiBuilder.group(OwnerActionApi, 'applyCommandAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          commands.push(payload.command);
          return posted;
        }),
      ),
    ).pipe(Layer.provide(applyCommandActionSchemaErrorLive)),
  ),
);

const field = (selector: string) =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLTextAreaElement>(selector)));
const typeInto = (selector: string, value: string) =>
  acted(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field(selector), value);
    field(selector).dispatchEvent(new Event('input', { bubbles: true }));
  });
const click = (name: string) =>
  acted(() => {
    Option.getOrThrow(Option.fromUndefinedOr(buttons(name)[0])).click();
  });
const openThread = Effect.gen(function* openThread() {
  yield* pinTestDocument;
  yield* agendaRecordsData.refresh(['documents']);
  const panel = yield* mountInRoute(<CommentThread subject={subject} />, { url: '/cs/thread' });
  yield* waitUntil(() => document.querySelector(composer) !== null);
  const left: string[] = [];
  panel.router.subscribe('onResolved', ({ toLocation }) => {
    if (toLocation.pathname === '/cs/left') {
      left.push('proceed');
    }
  });
  const navigate = (to: string) =>
    acted(() => {
      void panel.router.navigate({ to });
    });
  return { ...panel, left, navigate };
});

beforeEach(() => {
  commands.length = 0;
  comments.length = 0;
  agendaRecordsData.invalidate();
});
afterEach(unmountAll);

it.live('Uložit in the question posts the same comment and leaves once it went through', () =>
  Effect.gen(function* saveAndLeave() {
    const panel = yield* openThread;
    yield* typeInto(composer, ' Prosím o kontrolu ');
    yield* panel.navigate('/cs/left');
    yield* waitUntil(asked);
    yield* click(labels.save);
    yield* waitUntil(() => panel.router.state.location.pathname === '/cs/left');
    expect(commands).toEqual([
      {
        _tag: 'DocumentCommentPost',
        body: 'Prosím o kontrolu',
        subject: { id: 'property-1', kind: 'property', label: 'Rezidence' },
      },
    ]);
    expect(panel.left).toEqual(['proceed']);
  }).pipe(Effect.provide(network)),
);

it.live('a composer holding only spaces does not block leaving', () =>
  Effect.gen(function* blank() {
    const panel = yield* openThread;
    yield* typeInto(composer, '   ');
    yield* panel.navigate('/cs/left');
    yield* waitUntil(() => panel.router.state.location.pathname === '/cs/left');
    expect(asked()).toBe(false);
    expect(panel.left).toEqual(['proceed']);
  }).pipe(Effect.provide(network)),
);

it.live("Zrušit in the edit of one's own comment asks once the wording changed; Zůstat keeps it", () =>
  Effect.gen(function* editCancel() {
    comments.push(mine);
    const panel = yield* openThread;
    yield* click(editLabel);
    yield* panel.navigate('/cs/unchanged');
    yield* waitUntil(() => panel.router.state.location.pathname === '/cs/unchanged');
    expect(asked()).toBe(false);
    yield* typeInto(editor, 'Nové znění');
    yield* panel.navigate('/cs/left');
    yield* waitUntil(asked);
    expect(panel.router.state.location.pathname).toBe('/cs/unchanged');
    yield* click(labels.stay);
    yield* click(cancelLabel);
    expect(asked()).toBe(true);
    yield* click(labels.stay);
    expect(field(editor).value).toBe('Nové znění');
    yield* click(cancelLabel);
    yield* click(labels.discard);
    expect(document.body.querySelector(editor)).toBeNull();
    expect(commands).toEqual([]);
  }).pipe(Effect.provide(network)),
);
