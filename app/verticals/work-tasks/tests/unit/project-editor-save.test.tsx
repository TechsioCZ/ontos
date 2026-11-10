// @rstest-environment happy-dom
// The project panel as the user sees it: typing changes only the draft, and the one Save button sends the plan once.
import { Effect, Option, Schema } from 'effect';
import { afterEach, describe, expect, it, rstest } from 'effect-rstest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { PlanOutcome } from '../../src/routes/[lang]/ukoly/planning-proposal.ts';
import { ProjectEditor } from '../../src/routes/[lang]/ukoly/work-planning.tsx';
import { ProjectSchema } from '../../shared/apis/records.ts';
import type { WorkProject } from '../../shared/apis/records.ts';

// Outside a router: no route change is ever blocked here.
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
}));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));

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
  readonly closed: string[];
  readonly sent: { readonly _tag: string }[];
  readonly unmount: () => void;
}

const committed: PlanOutcome = { ok: true };
const mountedViews: Mounted[] = [];

afterEach(() => {
  for (const view of mountedViews.splice(0)) {
    view.unmount();
  }
});

const mount = (outcome: PlanOutcome): Effect.Effect<Mounted> =>
  Effect.promise(async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const closed: string[] = [];
    const sent: { readonly _tag: string }[] = [];
    await act(async () => {
      root.render(
        <ProjectEditor
          actorName={(principalId) => principalId}
          close={() => {
            closed.push('close');
          }}
          onApply={(command, done) => {
            sent.push(command);
            done(outcome);
          }}
          onProposed={() => {
            closed.push('proposed');
          }}
          principalNames={new Map()}
          principals={[]}
          project={project}
          proposed={Option.none()}
        />,
      );
    });
    let live = true;
    const view: Mounted = {
      closed,
      sent,
      unmount: () => {
        if (!live) {
          return;
        }
        live = false;
        act(() => {
          root.unmount();
        });
        container.remove();
      },
    };
    mountedViews.push(view);
    return view;
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
    act(async () => {
      const field = titleField();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    }),
  );

const clickSave = (): Effect.Effect<void> =>
  Effect.promise(() =>
    act(async () => {
      button('Uložit').click();
    }),
  );

describe('project panel save', () => {
  it.live('opening the panel and typing send nothing; the Save button sends the plan once', () =>
    Effect.gen(function* saveOnce() {
      const view = yield* mount(committed);
      expect(saveState()).toBe('idle');
      yield* typeTitle('Renamed project');
      expect(saveState()).toBe('dirty');
      yield* Effect.sleep('1 second');
      expect(view.sent).toEqual([]);
      yield* clickSave();
      expect(view.sent).toHaveLength(1);
      expect(view.sent[0]?._tag).toBe('UpdateProject');
      expect(view.closed).toEqual(['close']);
    }),
  );

  it.effect('an empty title keeps Save disabled and sends nothing', () =>
    Effect.gen(function* invalidTitle() {
      const view = yield* mount(committed);
      yield* typeTitle('   ');
      expect(saveState()).toBe('invalid');
      expect(button('Uložit').disabled).toBe(true);
      expect(view.sent).toEqual([]);
    }),
  );

  it.effect('unmounting with unsaved typing sends nothing', () =>
    Effect.gen(function* unmountSendsNothing() {
      const view = yield* mount(committed);
      yield* typeTitle('Unsaved name');
      view.unmount();
      expect(view.sent).toEqual([]);
    }),
  );
});
