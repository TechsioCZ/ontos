// @rstest-environment happy-dom
// The create panel as the user sees it: typing and ticking kinds send nothing, one click on Save sends the new tag
// once, and leaving with typed values asks first. Only the owner client, the i18n runtime and the router blocker are
// replaced.
import { Effect, Option, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { TagIdSchema } from '../../shared/apis/records.ts';
import { applyTaggingCommand } from '../../src/api/records-commands.ts';
import { TagCreatePanel } from '../../src/routes/[lang]/nastaveni/stitky/tag-create-panel.tsx';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

rstest.mock('../../src/api/records-commands.ts');
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
}));

const writes = () => rstest.mocked(applyTaggingCommand).mock.calls.length;

const settle = async (): Promise<void> => {
  await browserRuntime.runPromise(Effect.yieldNow);
};

interface View {
  readonly closed: string[];
  readonly unmount: () => void;
}

const views: View[] = [];

const mount = async (): Promise<View> => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const closed: string[] = [];
  await act(async () => {
    root.render(
      <TagCreatePanel
        onClose={() => {
          closed.push('close');
        }}
      />,
    );
    await settle();
  });
  let live = true;
  const view: View = {
    closed,
    unmount: () => {
      if (live) {
        live = false;
        act(() => {
          root.unmount();
          container.remove();
        });
      }
    },
  };
  views.push(view);
  return view;
};

const buttons = (name: string): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent?.trim() === name);

const button = (name: string): HTMLButtonElement => {
  const [found] = buttons(name);
  expect(found).toBeDefined();
  return found ?? document.createElement('button');
};

const nameField = (): HTMLInputElement =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>('input[id="tag-name"]')));

/** Types like a user: React sees a native input event, then the field loses focus. */
const typeName = async (value: string) => {
  await act(async () => {
    const field = nameField();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await settle();
  });
};

/** Ticks one subject kind the way a user does: through its visible label. */
const tickKind = async (kind: string) => {
  const label = Option.getOrThrow(
    Option.fromUndefinedOr(
      [...document.querySelectorAll<HTMLLabelElement>('label')].find(
        (candidate) => candidate.textContent?.trim() === `tagging.kinds.${kind}`,
      ),
    ),
  );
  await act(async () => {
    label.click();
    await settle();
  });
};

const click = async (target: HTMLElement) => {
  await act(async () => {
    target.click();
    await settle();
  });
};

const waitUntil = async (condition: () => boolean, attempt = 0): Promise<void> => {
  if (condition() || attempt >= 400) {
    expect(condition()).toBe(true);
    return;
  }
  await act(settle);
  await waitUntil(condition, attempt + 1);
};

const text = () => document.body.textContent ?? '';

const saveState = () => document.querySelector<HTMLElement>('[data-save-state]')?.dataset.saveState;

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  rstest.resetAllMocks();
  rstest
    .mocked(applyTaggingCommand)
    .mockReturnValue(
      Effect.succeed({ affectedAssignments: 0, revision: 2, tagId: Schema.decodeSync(TagIdSchema)('tag-new') }),
    );
});

afterEach(() => {
  for (const view of views) {
    view.unmount();
  }
  views.length = 0;
  rstest.unstubAllGlobals();
});

describe('tag create panel with one Save button', () => {
  it.live('typing and ticking kinds changes only the draft: nothing is sent after a pause or on unmount', () =>
    Effect.gen(function* typingSendsNothing() {
      const view = yield* Effect.promise(mount);
      expect(buttons('Uložit')).toHaveLength(1);
      expect(button('Uložit').disabled).toBe(true);
      expect(text()).not.toMatch(/automat/iu);

      yield* Effect.promise(() => typeName('VIP klient'));
      yield* Effect.promise(() => tickKind('order'));
      expect(button('Uložit').disabled).toBe(false);
      expect(text()).toContain('Neuložené změny');
      yield* Effect.sleep('1 second');
      yield* Effect.promise(() => act(settle));
      view.unmount();
      yield* Effect.promise(() => act(settle));
      expect(writes()).toBe(0);
    }),
  );

  it.effect('one click on Save creates the tag once and closes the panel', () =>
    Effect.gen(function* saveOnce() {
      const view = yield* Effect.promise(mount);
      yield* Effect.promise(() => typeName('VIP klient'));
      yield* Effect.promise(() => tickKind('order'));
      yield* Effect.promise(() => click(button('Uložit')));
      yield* Effect.promise(() => waitUntil(() => view.closed.length === 1));
      expect(writes()).toBe(1);
      expect(rstest.mocked(applyTaggingCommand).mock.calls[0]?.[0]).toMatchObject({
        _tag: 'CreateTag',
        name: 'VIP klient',
        subjectKinds: ['order'],
      });
    }),
  );

  it.effect('a draft without a subject kind cannot be saved', () =>
    Effect.gen(function* invalid() {
      yield* Effect.promise(mount);
      yield* Effect.promise(() => typeName('VIP klient'));
      expect(saveState()).toBe('invalid');
      expect(button('Uložit').disabled).toBe(true);
      expect(writes()).toBe(0);
    }),
  );

  it.effect('leaving with typed values asks; Zůstat keeps the draft, Zahodit změny leaves without sending', () =>
    Effect.gen(function* leave() {
      const view = yield* Effect.promise(mount);
      yield* Effect.promise(() => typeName('VIP klient'));
      yield* Effect.promise(() => click(button('tagging.tags.form.cancel')));
      expect(buttons('Zahodit změny')).toHaveLength(1);
      expect(view.closed).toEqual([]);

      yield* Effect.promise(() => click(button('Zůstat')));
      yield* Effect.promise(() => waitUntil(() => buttons('Zůstat').length === 0));
      expect(nameField().value).toBe('VIP klient');

      yield* Effect.promise(() => click(button('tagging.tags.form.cancel')));
      yield* Effect.promise(() => click(button('Zahodit změny')));
      expect(view.closed).toEqual(['close']);
      expect(writes()).toBe(0);
    }),
  );
});
