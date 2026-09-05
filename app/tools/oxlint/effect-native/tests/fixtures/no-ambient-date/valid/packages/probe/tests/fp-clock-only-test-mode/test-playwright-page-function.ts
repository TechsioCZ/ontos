// FALSE POSITIVE repro (testMode: "clock-only").
//
// Real hits this reproduces:
//   apps/shell-super-app/tests/e2e/login.spec.ts:80
//   apps/shell-super-app/tests/e2e/login.spec.ts:83
//
// The arrow function is serialised by Playwright and evaluated INSIDE the Chromium page, not in
// the Node test process. `document` / `HTMLFormElement` in the same body prove the execution
// context. There is no Effect runtime, no `Clock` and no `TestClock` reachable from that scope, and
// the wait is deliberately measuring real browser hydration wall time. The audit's D tier keeps
// "Promise adapters forced by ... Playwright" -- the same reasoning applies to a clock read that
// only exists inside a browser-evaluated predicate. There is no Effect-native replacement, so the
// diagnostic is unactionable.

declare const page: {
  waitForFunction: (predicate: () => boolean) => Promise<void>;
  evaluate: <T>(body: () => T) => Promise<T>;
};

export const waitForHydratedForm = async (): Promise<void> => {
  await page.waitForFunction(() => {
    const form = document.querySelector<HTMLFormElement>("form");
    if (form === null) return false;
    const since = Number(form.dataset["hydratedSince"]);
    if (!Number.isFinite(since)) {
      form.dataset["hydratedSince"] = String(performance.now());
      return false;
    }
    return performance.now() - since >= 1000;
  });
};

export const readPageTime = async (): Promise<number> => await page.evaluate(() => Date.now());
