// @rstest-environment happy-dom
// The tag edit panel as the user sees it: one Save button in the panel footer, the draft's status next to it, and a
// question before unsaved changes are left. Only the owner client, the i18n runtime and the router blocker are
// replaced.
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { DateTime, Effect, Option, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { TagIdSchema } from '../../shared/apis/records.ts';
import type { TagWithCounts } from '../../shared/apis/records.ts';
import { applyTaggingCommandIfUnchanged } from '../../src/tags/records-commands.ts';
import { TagEditPanel } from '../../src/routes/[lang]/nastaveni/stitky/tag-edit-panel.tsx';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

rstest.mock('../../src/tags/records-commands.ts');
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
}));

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

const writes = () => rstest.mocked(applyTaggingCommandIfUnchanged).mock.calls.length;

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
      <TagEditPanel
        onClose={() => {
          closed.push('close');
        }}
        tag={vip}
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
  rstest.mocked(applyTaggingCommandIfUnchanged).mockReturnValue(Effect.succeed('applied'));
});

afterEach(() => {
  for (const view of views) {
    view.unmount();
  }
  views.length = 0;
  rstest.unstubAllGlobals();
});

describe('tag edit panel with one Save button', () => {
  it.live('typing changes only the draft: nothing is sent after a pause, a blur or unmount', () =>
    Effect.gen(function* typingSendsNothing() {
      const view = yield* Effect.promise(mount);
      expect(buttons('Uložit')).toHaveLength(1);
      expect(button('Uložit').disabled).toBe(true);
      expect(text()).not.toMatch(/automat/iu);

      yield* Effect.promise(() => typeName('VIP klient'));
      expect(button('Uložit').disabled).toBe(false);
      expect(text()).toContain('Neuložené změny');
      // Longer than any debounce the panel ever had.
      yield* Effect.sleep('1 second');
      yield* Effect.promise(() => act(settle));
      view.unmount();
      yield* Effect.promise(() => act(settle));
      expect(writes()).toBe(0);
    }),
  );

  it.effect('one click on Save sends one update and shows it saved', () =>
    Effect.gen(function* saveOnce() {
      yield* Effect.promise(mount);
      yield* Effect.promise(() => typeName('VIP klient'));
      yield* Effect.promise(() => click(button('Uložit')));
      yield* Effect.promise(() => waitUntil(() => text().includes('Uloženo')));
      expect(writes()).toBe(1);
      expect(rstest.mocked(applyTaggingCommandIfUnchanged).mock.calls[0]?.[0]).toMatchObject({
        _tag: 'UpdateTag',
        patch: { name: 'VIP klient' },
      });
      expect(button('Uložit').disabled).toBe(true);
    }),
  );

  it.effect('an invalid draft cannot be saved', () =>
    Effect.gen(function* invalid() {
      yield* Effect.promise(mount);
      yield* Effect.promise(() => typeName(' '));
      expect(saveState()).toBe('invalid');
      expect(button('Uložit').disabled).toBe(true);
      expect(writes()).toBe(0);
    }),
  );

  it.effect('closing with unsaved changes asks; Zůstat keeps the draft, Zahodit změny closes without sending', () =>
    Effect.gen(function* leave() {
      const view = yield* Effect.promise(mount);
      yield* Effect.promise(() => typeName('VIP klient'));
      yield* Effect.promise(() => click(button('tagging.tags.form.close')));
      expect(buttons('Zahodit změny')).toHaveLength(1);
      expect(view.closed).toEqual([]);

      yield* Effect.promise(() => click(button('Zůstat')));
      yield* Effect.promise(() => waitUntil(() => buttons('Zůstat').length === 0));
      expect(nameField().value).toBe('VIP klient');

      yield* Effect.promise(() => click(button('tagging.tags.form.close')));
      yield* Effect.promise(() => click(button('Zahodit změny')));
      expect(view.closed).toEqual(['close']);
      expect(writes()).toBe(0);
    }),
  );

  it.effect('a clean panel closes without asking', () =>
    Effect.gen(function* cleanClose() {
      const view = yield* Effect.promise(mount);
      yield* Effect.promise(() => click(button('tagging.tags.form.close')));
      expect(buttons('Zůstat')).toHaveLength(0);
      expect(view.closed).toEqual(['close']);
    }),
  );

  it.effect('a tag someone else changed ends in a conflict, not an overwrite', () =>
    Effect.gen(function* conflict() {
      rstest.mocked(applyTaggingCommandIfUnchanged).mockReturnValue(Effect.succeed('stale'));
      yield* Effect.promise(mount);
      yield* Effect.promise(() => typeName('VIP klient'));
      yield* Effect.promise(() => click(button('Uložit')));
      yield* Effect.promise(() => waitUntil(() => saveState() === 'conflict'));
      expect(buttons('Načíst aktuální verzi')).toHaveLength(1);
      expect(writes()).toBe(1);
    }),
  );

  it.effect('a change parked for approval is sent once and never again', () =>
    Effect.gen(function* proposed() {
      const receipt = Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
        _tag: 'ActionProposalAccepted',
        expiresAt: '2026-11-10T12:00:00.000Z',
        proposalId: '60000000-0000-4000-8000-000000000001',
      });
      rstest.mocked(applyTaggingCommandIfUnchanged).mockReturnValue(Effect.fail(receipt));
      yield* Effect.promise(mount);
      yield* Effect.promise(() => typeName('VIP klient'));
      yield* Effect.promise(() => click(button('Uložit')));
      yield* Effect.promise(() => waitUntil(() => saveState() === 'proposed'));
      expect(button('Uložit').disabled).toBe(true);
      yield* Effect.promise(() => click(button('Uložit')));
      expect(writes()).toBe(1);
    }),
  );
});
