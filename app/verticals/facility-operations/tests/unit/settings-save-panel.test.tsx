// @rstest-environment happy-dom
// The notification settings form: a toggle changes only the draft. Nothing is sent while the user types, waits or
// leaves; the one Uložit button sends the whole draft once.
import { Effect, Option } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import type { SaveOutcome } from '@app/admin-ui';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';
import { SettingsPanel } from '../../src/routes/[lang]/provoz/agenda/inbox.tsx';

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
}));
rstest.mock('../../src/routes/[lang]/provoz/agenda/agenda-email.tsx', () => ({
  useEmailProvider: () => ({ kind: 'loading' }),
}));

const settle = async (): Promise<void> => {
  await browserRuntime.runPromise(Effect.yieldNow);
};

const mounted: Root[] = [];
const containers: HTMLElement[] = [];

type SaveSettings = Parameters<typeof SettingsPanel>[0]['onSave'];

const mountPanel = async (onSave: SaveSettings): Promise<HTMLElement> => {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  mounted.push(root);
  act(() => {
    root.render(createElement(SettingsPanel, { canWrite: true, me: 'me', onSave }));
  });
  await act(settle);
  return container;
};

const buttonNamed = (container: HTMLElement, text: string): HTMLButtonElement =>
  Option.getOrThrow(
    Option.fromUndefinedOr(
      [...container.querySelectorAll('button')].find((button) => button.textContent.trim() === text),
    ),
  );

const switchOf = (container: HTMLElement): HTMLElement =>
  Option.getOrThrow(Option.fromNullOr(container.querySelector<HTMLElement>('[role="switch"]')));

const waitUntil = async (condition: () => boolean, attempt = 0): Promise<void> => {
  if (condition() || attempt >= 200) {
    return;
  }
  await act(settle);
  await waitUntil(condition, attempt + 1);
};

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(() => {
  for (const root of mounted) {
    act(() => {
      root.unmount();
    });
  }
  mounted.length = 0;
  for (const container of containers) {
    container.remove();
  }
  containers.length = 0;
  rstest.unstubAllGlobals();
});

describe('notification settings save', () => {
  it.live('a toggle waits without sending; Uložit sends the draft once', () =>
    Effect.gen(function* explicitSave() {
      const onSave = rstest.fn((_value: Parameters<SaveSettings>[0]) => Effect.succeed<SaveOutcome>('saved'));
      const container = yield* Effect.promise(() => mountPanel(onSave));

      expect(buttonNamed(container, 'Uložit').disabled).toBe(true);

      yield* Effect.promise(() =>
        act(async () => {
          switchOf(container).click();
          await settle();
        }),
      );
      expect(buttonNamed(container, 'Uložit').disabled).toBe(false);

      yield* Effect.sleep('1 second');
      expect(onSave).not.toHaveBeenCalled();

      yield* Effect.promise(() =>
        act(async () => {
          buttonNamed(container, 'Uložit').click();
          await settle();
        }),
      );
      expect(onSave).toHaveBeenCalledTimes(1);

      yield* Effect.promise(() => waitUntil(() => container.textContent.includes('Uloženo')));
      expect(container.textContent.includes('Uloženo')).toBe(true);
      expect(onSave).toHaveBeenCalledTimes(1);
    }),
  );
});
