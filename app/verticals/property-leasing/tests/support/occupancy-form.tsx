// Mounting and driving the lease and stay form like a person: typing, picking, clicking. Every step settles React and the
// browser runtime before it ends. Shared by the form tests.
import { Effect, Option } from 'effect';
import { constVoid } from 'effect/Function';
import { expect } from 'effect-rstest';
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

/** Runs `step` inside React's act and lets the browser runtime finish what it started. */
const acted = (step: () => void) =>
  Effect.promise(async () => {
    await act(async () => {
      step();
      await browserRuntime.runPromise(Effect.yieldNow);
    });
  });

const unmounts: (() => void)[] = [];

export const mount = (element: ReactElement) => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  unmounts.push(() => {
    act(() => {
      root.unmount();
      container.remove();
    });
  });
  return acted(() => {
    root.render(element);
  });
};

export const unmountAll = () => {
  for (const unmount of unmounts.splice(0)) {
    unmount();
  }
};

export const buttons = (name: string): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent?.trim() === name);

export const button = (name: string): HTMLButtonElement => {
  const [found] = buttons(name);
  expect(found).toBeDefined();
  return found ?? document.createElement('button');
};

export const field = (id: string): HTMLInputElement =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>(`input[id="${id}"]`)));

/** Types like a person: React sees a native input event, then focus leaves the field. */
export const type = (id: string, value: string) =>
  acted(() => {
    const input = field(id);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });

export const click = (target: HTMLElement | undefined) =>
  acted(() => {
    expect(target).toBeDefined();
    target?.click();
  });

/** Picks the option `value` in the select labelled `label`, through the select's native element. */
export const pick = (label: string, value: string) =>
  acted(() => {
    const select = [...document.querySelectorAll<HTMLSelectElement>('select')].find(
      (candidate) =>
        document.querySelector(`[id="${candidate.getAttribute('aria-labelledby') ?? ''}"]`)?.textContent?.trim() ===
        label,
    );
    expect(select).toBeDefined();
    const native = select ?? document.createElement('select');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(native, value);
    native.dispatchEvent(new Event('change', { bubbles: true }));
  });

/** Settles until `condition` holds; fails when it never does. */
export const waitUntil = (condition: () => boolean): Effect.Effect<void> => {
  const attempt = (left: number): Effect.Effect<void> =>
    condition() || left === 0
      ? Effect.sync(() => {
          expect(condition()).toBe(true);
        })
      : acted(constVoid).pipe(Effect.andThen(Effect.suspend(() => attempt(left - 1))));
  return attempt(400);
};

export const text = () => document.body.textContent ?? '';
