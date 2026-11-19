// @rstest-environment happy-dom
// The project panel as the user sees it: typing changes only the draft, and the one Save button sends the plan once.
import { unmountAll } from '@app/admin-ui/testing/module-ui';
import { Deferred, Effect, Option, Schema } from 'effect';
import { afterEach, describe, expect, it } from 'effect-rstest';
import { act } from 'react';
import type { PlanOutcome } from '../../src/routes/[lang]/ukoly/planning-proposal.ts';
import { ProjectEditor } from '../../src/routes/[lang]/ukoly/work-planning.tsx';
import { ProjectSchema } from '../../shared/apis/records.ts';
import type { WorkProject } from '../../shared/apis/records.ts';
import { PlanningCommandSchema } from '../../shared/actions/apply-command.ts';

import { mountInRoute } from '../support/module-ui.ts';

const tenantId = '20000000-0000-4000-8000-000000000001';
const principalRef = { principalId: '40000000-0000-4000-8000-000000000001', tenantId };
const project: WorkProject = Schema.decodeUnknownSync(ProjectSchema)({
  createdAt: '2026-10-05T10:00:00.000Z',
  id: '30000000-0000-4000-8000-000000000001',
  milestones: [],
  plannedEnd: '2026-12-31',
  plannedStart: '2026-10-01',
  responsiblePrincipalRef: principalRef,
  state: 'PLANNED',
  title: 'Saved project',
  updatedAt: '2026-10-05T10:00:00.000Z',
});

interface Mounted {
  readonly applied: Deferred.Deferred<boolean>;
  readonly closed: string[];
  readonly sent: { readonly _tag: string }[];
  readonly unmount: () => void;
}

const committed: PlanOutcome = { ok: true };
afterEach(unmountAll);

const mount = (outcome: PlanOutcome): Effect.Effect<Mounted> =>
  Effect.gen(function* mountEditor() {
    const applied = yield* Deferred.make<boolean>();
    const closed: string[] = [];
    const sent: { readonly _tag: string }[] = [];
    yield* mountInRoute(
      <ProjectEditor
        actorName={(principalId) => principalId}
        close={() => {
          closed.push('close');
        }}
        onApply={(command, done) => {
          sent.push(command);
          done(outcome);
          Deferred.doneUnsafe(applied, Effect.succeed(true));
        }}
        onProposed={() => {
          closed.push('proposed');
        }}
        principalNames={new Map()}
        principals={[]}
        project={project}
        proposed={Option.none()}
      />,
      { path: 'ukoly', url: '/cs/ukoly' },
    );
    return { applied, closed, sent, unmount: unmountAll };
  });

const button = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  expect(found).toBeDefined();
  return found ?? document.createElement('button');
};

const saveState = () => document.querySelector<HTMLElement>('[data-save-state]')?.dataset.saveState;

const titleField = (): HTMLInputElement =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>('input[id="project-title"]')));

/** Types like a user: a native input event, then the field loses focus. */
const typeTitle = (value: string): Effect.Effect<void> =>
  Effect.promise(() =>
    act(() => {
      const field = titleField();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      return Promise.resolve();
    }),
  );

const clickSave = (): Effect.Effect<void> =>
  Effect.promise(() =>
    act(() => {
      button('Uložit').click();
      return Promise.resolve();
    }),
  );

describe('project panel save', () => {
  it.live('maps a renamed project while retaining its dates, state and responsible principal', () =>
    Effect.gen(function* saveOnce() {
      const view = yield* mount(committed);
      yield* typeTitle('Renamed project');
      yield* clickSave();
      // The injected apply reply has run the panel's committed/failed/proposed callback to completion.
      yield* Deferred.await(view.applied);
      expect(view.sent).toHaveLength(1);
      expect(
        Schema.is(PlanningCommandSchema.pipe(Schema.toTaggedUnion('_tag')).cases.UpdateProject)(view.sent[0]),
      ).toBe(true);
      expect(view.sent[0]).toMatchObject({
        id: project.id,
        milestones: [],
        plannedEnd: '2026-12-31',
        plannedStart: '2026-10-01',
        responsiblePrincipalRef: principalRef,
        state: 'PLANNED',
        title: 'Renamed project',
      });
      expect(view.closed).toEqual(['close']);
    }),
  );

  it.live('an empty title keeps Save disabled and sends nothing', () =>
    Effect.gen(function* invalidTitle() {
      const view = yield* mount(committed);
      yield* typeTitle('   ');
      expect(saveState()).toBe('invalid');
      expect(button('Uložit').disabled).toBe(true);
      yield* clickSave();
      expect(view.sent).toEqual([]);
    }),
  );
});
