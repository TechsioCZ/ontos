// @rstest-environment happy-dom
import {
  browserNetwork,
  networkIdle,
  networkQuietExcept,
  serveApi,
} from "@app/shared-contracts/testing/http-double";
import { HttpApiBuilder } from "@modern-js/bff-effect/effect-edge";
import { ToastProvider, useToast } from "@techsio/ui-kit/molecules/toast";
import { rs } from "@rstest/core";
import { Deferred, Effect } from "effect";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "effect-rstest";
import { CardVariants } from "../src/features/card-variants";
import { getDictionary } from "../src/i18n";
import { CardVariantsApi } from "../src/ontos/card-variants";
import type { CardVariantsQuery, CardVariantsResult } from "../src/ontos/card-variants";
import type { ProductCardModel } from "../src/ontos/catalog-model";

let container: HTMLDivElement;
let root: Root;
let sequence = 0;
let toastStore: ReturnType<typeof useToast> | null = null;

// Observe the real provider's persisted notification options, without replacing its actions.
const ToastOptions = () => {
  const store = useToast();
  useLayoutEffect(() => {
    toastStore = store;
    return () => {
      toastStore = null;
    };
  }, [store]);
  return null;
};
const flushReact = () => act(async () => {});
const idle = networkIdle.pipe(Effect.andThen(Effect.promise(flushReact)));
const notifications = () =>
  document.querySelectorAll<HTMLElement>('[data-scope="toast"][data-part="root"]');
const trigger = () => {
  const button = container.querySelector("button");
  if (button === null) {
    throw new Error("Missing actual variant expansion trigger");
  }
  return button;
};
const busy = () => container.querySelector("[aria-busy]")?.getAttribute("aria-busy");
const expectClosed = () => {
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  expect(
    document.querySelector('[data-scope="popover"][data-part="content"][data-state="open"]'),
  ).toBeNull();
};
const interact = (action: () => void) =>
  Effect.promise(() =>
    act(async () => {
      action();
    }),
  );

const previewHandlers = (
  reads: CardVariantsQuery[],
  arrived: Deferred.Deferred<null>,
  answer: Deferred.Deferred<CardVariantsResult>,
) =>
  HttpApiBuilder.group(CardVariantsApi, "cardVariants", (group) =>
    group.handle("read", ({ query: received }) =>
      Effect.gen(function* servePreview() {
        reads.push(received);
        yield* Deferred.succeed(arrived, null);
        return yield* Deferred.await(answer);
      }),
    ),
  );
const waitForNotBusy = () =>
  rs.waitFor(async () => {
    await flushReact();
    expect(busy()).toBe("false");
  });
const waitForOneNotification = () =>
  rs.waitFor(async () => {
    await flushReact();
    expect(notifications()).toHaveLength(1);
  });

const preview = (locale: "cs" | "en" = "cs") =>
  Effect.gen(function* preparePreview() {
    sequence += 1;
    // Each mounted product has its own real production-cache identity.
    const id = `preview-lifecycle-${sequence}`;
    const query: CardVariantsQuery = { locale, productId: id, slug: id };
    const product: ProductCardModel = {
      currency: "CZK",
      description: "",
      id,
      image: null,
      name: `Owner ${id}`,
      priceFrom: false,
      priceMinor: 100,
      sku: id,
      slug: id,
      stock: "available",
      variantCount: 2,
      variantPreview: [{ id: "small", name: "Owner small" }],
    };
    const ready: CardVariantsResult = {
      productId: id,
      slug: id,
      state: "ready",
      variants: [
        { id: "small", name: "Owner small" },
        { id: "large", name: "Owner large" },
      ],
    };
    const arrived = yield* Deferred.make<null>();
    const answer = yield* Deferred.make<CardVariantsResult>();
    const reads: CardVariantsQuery[] = [];
    const handlers = previewHandlers(reads, arrived, answer);
    const mount = Effect.promise(() =>
      act(async () => {
        root.render(
          <ToastProvider>
            <ToastOptions />
            <CardVariants locale={locale} product={product} />
          </ToastProvider>,
        );
      }),
    );
    const pending = Effect.gen(function* awaitPendingRead() {
      yield* Deferred.await(arrived);
      yield* networkQuietExcept(1);
      yield* Effect.promise(flushReact);
      expect(busy()).toBe("true");
      expect(reads).toEqual([query]);
    });
    const settle = (response: CardVariantsResult) =>
      Effect.gen(function* finishPreviewRead() {
        yield* Deferred.succeed(answer, response);
        yield* idle;
        // The component observer has consumed the decoded HTTP result, not just the server response.
        yield* Effect.promise(waitForNotBusy);
        yield* idle;
        expect(reads).toEqual([query]);
      });
    return {
      locale,
      mount,
      network: browserNetwork(serveApi(CardVariantsApi, handlers)),
      pending,
      query,
      reads,
      ready,
      settle,
    };
  });

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe("mounted card variant preview request lifecycle", () => {
  it.live("is not busy and sends no variants read before interaction", () =>
    Effect.gen(function* untouchedPreview() {
      const p = yield* preview();
      yield* Effect.gen(function* verifyUntouched() {
        yield* p.mount;
        yield* idle;
        expect(busy()).toBe("false");
        expect(p.reads).toEqual([]);
        expectClosed();
        expect(notifications()).toHaveLength(0);
      }).pipe(Effect.provide(p.network));
    }),
  );

  it.live(
    "consumes pending Escape, ignores restored focus and keeps a late ready result closed",
    () =>
      Effect.gen(function* cancelReadyPreview() {
        const p = yield* preview();
        yield* Effect.gen(function* verifyCancellation() {
          yield* p.mount;
          yield* interact(() => trigger().click());
          yield* p.pending;
          const dismissKeyEvent = new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "Escape",
          });
          yield* interact(() => {
            trigger().dispatchEvent(dismissKeyEvent);
          });
          expect(dismissKeyEvent.defaultPrevented).toBe(true);
          yield* interact(() => trigger().focus());
          yield* networkQuietExcept(1);
          yield* Effect.promise(flushReact);
          expect(p.reads).toEqual([p.query]);
          yield* p.settle(p.ready);
          expectClosed();
          expect(notifications()).toHaveLength(0);
        }).pipe(Effect.provide(p.network));
      }),
  );

  it.live(
    "leaves pending ArrowDown unconsumed and opens the later ready variants without an error",
    () =>
      Effect.gen(function* allowArrowDown() {
        const p = yield* preview();
        yield* Effect.gen(function* verifyReady() {
          yield* p.mount;
          yield* interact(() => trigger().click());
          yield* p.pending;
          const arrow = new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "ArrowDown",
          });
          yield* interact(() => {
            trigger().dispatchEvent(arrow);
          });
          expect(arrow.defaultPrevented).toBe(false);
          yield* p.settle(p.ready);
          yield* Effect.promise(() =>
            rs.waitFor(async () => {
              await flushReact();
              expect(trigger().getAttribute("aria-expanded")).toBe("true");
              const content = document.querySelector(
                '[data-scope="popover"][data-part="content"][data-state="open"]',
              );
              expect(content?.textContent).toContain("Owner large");
              expect(
                content?.querySelector(`a[href="/cs/produkt/${p.query.slug}?variantId=large"]`),
              ).not.toBeNull();
            }),
          );
          yield* idle;
          expect(notifications()).toHaveLength(0);
        }).pipe(Effect.provide(p.network));
      }),
  );

  it.live.each(["cs", "en"] as const)(
    "announces one localized ten-second error for an unavailable explicit expansion in %s",
    (locale) =>
      Effect.gen(function* announceUnavailable() {
        const p = yield* preview(locale);
        yield* Effect.gen(function* verifyAnnouncement() {
          yield* p.mount;
          yield* interact(() => trigger().click());
          yield* p.pending;
          yield* p.settle({ state: "unavailable" });
          yield* Effect.promise(waitForOneNotification);
          yield* idle;
          expectClosed();
          expect(notifications()).toHaveLength(1);
          const [notification] = notifications();
          expect(notification?.dataset.type).toBe("error");
          expect(notification?.querySelector('[data-part="title"]')?.textContent).toBe(
            getDictionary(locale).variantsUnavailable,
          );
          expect(toastStore?.getVisibleToasts()).toEqual([
            expect.objectContaining({
              duration: 10_000,
              title: getDictionary(locale).variantsUnavailable,
              type: "error",
            }),
          ]);
        }).pipe(Effect.provide(p.network));
      }),
  );

  it.live.each(["focus", "pointer"] as const)(
    "keeps an unavailable passive %s preview closed and quiet after its single read",
    (source) =>
      Effect.gen(function* passivePreview() {
        const p = yield* preview();
        yield* Effect.gen(function* verifyPassiveFailure() {
          yield* p.mount;
          yield* interact(() => {
            if (source === "focus") {
              trigger().focus();
            } else {
              trigger().dispatchEvent(
                new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }),
              );
            }
          });
          yield* p.pending;
          yield* p.settle({ state: "unavailable" });
          expectClosed();
          expect(notifications()).toHaveLength(0);
        }).pipe(Effect.provide(p.network));
      }),
  );

  it.live("suppresses a late unavailable response after pending Escape cancellation", () =>
    Effect.gen(function* cancelUnavailable() {
      const p = yield* preview();
      yield* Effect.gen(function* verifyCancelledFailure() {
        yield* p.mount;
        yield* interact(() => trigger().click());
        yield* p.pending;
        const dismissKeyEvent = new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Escape",
        });
        yield* interact(() => {
          trigger().dispatchEvent(dismissKeyEvent);
        });
        expect(dismissKeyEvent.defaultPrevented).toBe(true);
        yield* p.settle({ state: "unavailable" });
        expectClosed();
        expect(notifications()).toHaveLength(0);
      }).pipe(Effect.provide(p.network));
    }),
  );
});
