// @rstest-environment happy-dom
// The create-project form sends its create only from the shared Save button ("Uložit"): typing and Enter change only
// the draft, an untouched form leaves without asking, and leaving with typed input asks first. Only the generated
// clients, the i18n runtime and the router blocker are replaced.
import { saveLabelsFor } from '@app/admin-ui';
import { Effect, Option } from 'effect';
import { afterEach, expect, it, rstest } from 'effect-rstest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { CreateProjectActionCommitIndeterminateProblemSchema } from '../../shared/apis/create-project-action.ts';
import { executeCreateProject } from '../../src/api/create-project-action-client.ts';
import { CreateProjectForm } from '../../src/routes/[lang]/projects/create-project/create-project-form.tsx';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

interface Navigation {
  proceeded: number;
  shouldBlock: () => boolean;
  status: 'blocked' | 'idle';
}
const { navigation } = rstest.hoisted(() => {
  const state: Navigation = { proceeded: 0, shouldBlock: () => false, status: 'idle' };
  return { navigation: state };
});
const owner = { displayName: 'Jana', principalId: '00000000-0000-4000-8000-000000000021' };

rstest.mock('../../src/api/create-project-action-client.ts', () => ({
  executeCreateProject: rstest.fn(() => Effect.succeed({})),
}));
rstest.mock('../../src/api/project-owner-candidates-client.ts', () => ({
  executeProjectOwnerCandidates: () => Effect.succeed({ candidates: [owner] }),
}));
rstest.mock('@modern-js/plugin-i18n/runtime/consumer', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: (options: { readonly shouldBlockFn: () => boolean }) => {
    navigation.shouldBlock = options.shouldBlockFn;
    return {
      proceed: () => {
        navigation.status = 'idle';
        navigation.proceeded += 1;
      },
      reset: () => {
        navigation.status = 'idle';
      },
      status: navigation.status,
    };
  },
}));

const labels = saveLabelsFor('cs');
const settle = async (): Promise<void> => {
  await browserRuntime.runPromise(Effect.yieldNow);
};
const unmounts: (() => void)[] = [];
afterEach(() => {
  for (const unmount of unmounts.splice(0)) {
    unmount();
  }
  navigation.proceeded = 0;
  navigation.status = 'idle';
  rstest.mocked(executeCreateProject).mockClear();
});

const mount = async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<CreateProjectForm />);
    await settle();
  });
  unmounts.push(() => {
    act(() => {
      root.unmount();
      container.remove();
    });
  });
  return () =>
    Effect.promise(() =>
      act(async () => {
        root.render(<CreateProjectForm />);
        await settle();
      }),
    );
};

const buttonNamed = (name: string): HTMLButtonElement =>
  Option.getOrThrow(
    Option.fromNullishOr(
      [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === name),
    ),
  );
const field = (selector: string): HTMLInputElement =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>(selector)));
const act$ = (run: () => void) =>
  Effect.promise(() =>
    act(async () => {
      run();
      await settle();
    }),
  );
const typeInto = (id: string, value: string) =>
  act$(() => {
    const input = field(`#${id}`);
    const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
const waitUntil = async (condition: () => boolean, attempt = 0): Promise<void> => {
  if (condition() || attempt >= 400) {
    expect(condition()).toBe(true);
    return;
  }
  await act(settle);
  await waitUntil(condition, attempt + 1);
};

it.live('typing and Enter send nothing; Uložit creates once and the page can be left', () =>
  Effect.gen(function* createOnce() {
    yield* Effect.promise(mount);
    expect(navigation.shouldBlock()).toBe(false);
    yield* typeInto('project-name', 'Nový web');
    yield* typeInto('project-prefix', 'WEB');
    yield* act$(() => buttonNamed('projects.pages.createProject.findOwners').click());
    yield* Effect.promise(() =>
      waitUntil(() => document.querySelector(`input[value="${owner.principalId}"]`) !== null),
    );
    yield* act$(() => field(`input[value="${owner.principalId}"]`).click());
    yield* act$(() => field('#project-name').form?.requestSubmit());
    expect(executeCreateProject).not.toHaveBeenCalled();
    expect(navigation.shouldBlock()).toBe(true);
    yield* act$(() => buttonNamed(labels.save).click());
    yield* Effect.promise(() => waitUntil(() => (document.body.textContent ?? '').includes(labels.saved)));
    expect(executeCreateProject).toHaveBeenCalledTimes(1);
    expect(rstest.mocked(executeCreateProject).mock.calls[0]?.[0]).toMatchObject({
      name: 'Nový web',
      ownerPrincipalId: owner.principalId,
      prefix: 'WEB',
    });
    expect(navigation.shouldBlock()).toBe(false);
  }),
);

const uncertain: typeof CreateProjectActionCommitIndeterminateProblemSchema.Type = {
  _tag: 'CreateProjectActionCommitIndeterminateProblem',
  detail: 'uncertain',
  invocationId: 'invocation-1',
  resolution: 'RESOLVE_COMMIT',
  retryCommand: false,
  status: 503,
  title: 'uncertain',
  type: 'about:blank',
};

it.live('an uncertain create locks the inputs, and Uložit retries the same draft with the same key', () =>
  Effect.gen(function* uncertainLock() {
    rstest.mocked(executeCreateProject).mockImplementationOnce(() => Effect.fail(uncertain));
    yield* Effect.promise(mount);
    yield* typeInto('project-name', 'Nový web');
    yield* typeInto('project-prefix', 'WEB');
    yield* act$(() => buttonNamed('projects.pages.createProject.findOwners').click());
    yield* Effect.promise(() =>
      waitUntil(() => document.querySelector(`input[value="${owner.principalId}"]`) !== null),
    );
    yield* act$(() => field(`input[value="${owner.principalId}"]`).click());
    yield* act$(() => buttonNamed(labels.save).click());
    yield* Effect.promise(() => waitUntil(() => document.querySelector('[data-save-state="error"]') !== null));
    expect(field('#project-name').disabled).toBe(true);
    expect(field('#project-prefix').disabled).toBe(true);
    expect(buttonNamed('projects.pages.createProject.findOwners').disabled).toBe(true);
    yield* act$(() => buttonNamed(labels.save).click());
    yield* Effect.promise(() => waitUntil(() => (document.body.textContent ?? '').includes(labels.saved)));
    const { calls } = rstest.mocked(executeCreateProject).mock;
    expect(calls).toHaveLength(2);
    expect(calls[1]?.[0]).toEqual(calls[0]?.[0]);
    expect(calls[1]?.[2]).toEqual(calls[0]?.[2]);
    expect(navigation.shouldBlock()).toBe(false);
  }),
);

it.live('leaving with typed input asks, and Zahodit změny leaves without creating', () =>
  Effect.gen(function* leaveDiscard() {
    const rerender = yield* Effect.promise(mount);
    yield* typeInto('project-name', 'Rozpracovaný');
    expect(navigation.shouldBlock()).toBe(true);
    navigation.status = 'blocked';
    yield* rerender();
    yield* act$(() => buttonNamed(labels.discard).click());
    expect(navigation.proceeded).toBe(1);
    expect(executeCreateProject).not.toHaveBeenCalled();
    yield* rerender();
    expect(field('#project-name').value).toBe('');
    expect(navigation.shouldBlock()).toBe(false);
  }),
);
