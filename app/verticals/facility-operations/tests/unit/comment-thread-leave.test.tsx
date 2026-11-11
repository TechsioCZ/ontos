// @rstest-environment happy-dom
// A typed comment is input: leaving the record with it asks the shared question instead of dropping it. Posting stays
// the composer's own command; Uložit in the question posts the same comment and leaves once it went through.
import { Effect, Schema } from 'effect' with { rstest: 'importActual' };
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { createElement } from 'react';
import type { OpsCommand } from '../../shared/agendas.ts';
import { CommentSchema } from '../../shared/domain/documents.ts';
import type { CommentRecord } from '../../shared/domain/documents.ts';
import { CommentThread } from '../../src/ui/comment-thread.tsx';
import { bodyText, click, fieldValue, labels, mountPanel, typeInto, unmountPanels } from './draft-base-fixture.ts';

interface Blocker {
  proceed: () => void;
  reset: () => void;
  shouldBlock: () => boolean;
  status: 'blocked' | 'idle';
}
const {
  blocker,
  run,
  thread: threadState,
} = rstest.hoisted(() => {
  const state: Blocker = { proceed: () => {}, reset: () => {}, shouldBlock: () => false, status: 'idle' };
  const calls: OpsCommand[] = [];
  const comments: CommentRecord[] = [];
  return { blocker: state, run: { calls }, thread: { comments } };
});

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: (options: { readonly shouldBlockFn: () => boolean }) => {
    blocker.shouldBlock = options.shouldBlockFn;
    return { proceed: () => blocker.proceed(), reset: () => blocker.reset(), status: blocker.status };
  },
}));
rstest.mock('../../src/ui/use-agenda.ts', () => ({
  useAgendaRecords: () => ({
    access: () => {},
    data: {
      actorPrincipalRef: { principalId: '72000000-0000-4000-8000-000000000021' },
      agendas: { documents: { canWrite: true, state: { comments: threadState.comments, documents: [] } } },
    },
    reload: () => {},
    run: (command: OpsCommand) => {
      run.calls.push(command);
      return Effect.succeed({ ok: true });
    },
    status: 'ready',
  }),
}));

const subject = { id: 'property-1', kind: 'property', label: 'Rezidence' } as const;
const thread = () => createElement(CommentThread, { subject });
const composer = 'textarea';
const asked = () => bodyText().includes(labels.leaveDescription);

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  blocker.status = 'idle';
  run.calls.length = 0;
  threadState.comments.length = 0;
});

afterEach(() => {
  unmountPanels();
});

it.effect('an empty composer lets the record go without asking', () =>
  Effect.gen(function* untouched() {
    yield* mountPanel(thread());
    expect(blocker.shouldBlock()).toBe(false);
  }),
);

it.effect('leaving with a typed comment asks; Zahodit změny drops it and leaves without posting', () =>
  Effect.gen(function* discard() {
    const panel = yield* mountPanel(thread());
    yield* typeInto(composer, 'Prosím o kontrolu');
    expect(blocker.shouldBlock()).toBe(true);
    const left: string[] = [];
    blocker.proceed = () => {
      left.push('proceed');
    };
    blocker.status = 'blocked';
    yield* panel.render(thread());
    expect(asked()).toBe(true);
    yield* click(labels.discard);
    expect(left).toEqual(['proceed']);
    expect(run.calls).toEqual([]);
    blocker.status = 'idle';
    yield* panel.render(thread());
    expect(blocker.shouldBlock()).toBe(false);
  }),
);

it.effect('Uložit in the question posts the same comment and leaves once it went through', () =>
  Effect.gen(function* saveAndLeave() {
    const panel = yield* mountPanel(thread());
    yield* typeInto(composer, ' Prosím o kontrolu ');
    const left: string[] = [];
    blocker.proceed = () => {
      left.push('proceed');
    };
    blocker.status = 'blocked';
    yield* panel.render(thread());
    yield* click(labels.save);
    // The post answers on the browser runtime; the question leaves once it did.
    for (let turn = 0; turn < 50 && left.length === 0; turn += 1) {
      yield* panel.render(thread());
    }
    expect(run.calls).toEqual([
      {
        _tag: 'DocumentCommentPost',
        body: 'Prosím o kontrolu',
        subject: { id: 'property-1', kind: 'property', label: 'Rezidence' },
      },
    ]);
    expect(left).toEqual(['proceed']);
  }),
);

it.effect('a composer holding only spaces does not block leaving', () =>
  Effect.gen(function* blank() {
    yield* mountPanel(thread());
    yield* typeInto(composer, '   ');
    expect(blocker.shouldBlock()).toBe(false);
  }),
);

const actor = { principalId: '72000000-0000-4000-8000-000000000021', tenantId: '70000000-0000-4000-8000-000000000020' };
const mine = Schema.decodeUnknownSync(CommentSchema)({
  body: 'Původní znění',
  createdAt: '2026-10-20T08:00:00Z',
  createdBy: actor,
  edits: [],
  id: 'comment-1',
  subject: { id: 'property-1', kind: 'property', label: 'Rezidence' },
  updatedAt: '2026-10-20T08:00:00Z',
  updatedBy: actor,
});
const editLabel = 'facility-operations.documents.comments.edit';
const cancelLabel = 'facility-operations.documents.comments.cancel';
const editor = 'textarea[aria-label="facility-operations.documents.comments.edit"]';

it.effect("Zrušit in the edit of one's own comment asks once the wording changed; Zůstat keeps it", () =>
  Effect.gen(function* editCancel() {
    threadState.comments.push(mine);
    yield* mountPanel(thread());
    yield* click(editLabel);
    expect(blocker.shouldBlock()).toBe(false);
    yield* typeInto(editor, 'Nové znění');
    expect(blocker.shouldBlock()).toBe(true);
    yield* click(cancelLabel);
    expect(asked()).toBe(true);
    yield* click(labels.stay);
    expect(fieldValue(editor)).toBe('Nové znění');
    yield* click(cancelLabel);
    yield* click(labels.discard);
    expect(document.body.querySelector(editor)).toBeNull();
    expect(run.calls).toEqual([]);
  }),
);
