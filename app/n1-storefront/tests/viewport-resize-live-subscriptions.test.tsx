// @rstest-environment happy-dom
import { afterEach, beforeEach, expect, it } from "@rstest/core";
import { Predicate, Schema } from "effect";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { productViewport, useDesktopProduct } from "../src/features/product-viewport";

const narrowWidth = 767;
const desktopWidth = 768;
const originalViewport = { height: window.innerHeight, width: window.innerWidth };
const cleanups = new Set<() => void>();

const NativeViewportController = Schema.Struct({
  setViewport: Schema.declare(Predicate.isFunction),
});

const resize = (width: number, height = originalViewport.height) => {
  // Rstest exposes the real detached-window controller, but its ambient type
  // only declares the fetch settings used by the shared HTTP test support.
  const controller = window.happyDOM;
  const { setViewport } = Schema.decodeUnknownSync(NativeViewportController)(controller);
  flushSync(() => {
    setViewport.call(controller, { height, width });
  });
};

const ViewportView = ({ label }: { label: string }) => {
  const desktop = useDesktopProduct();
  return <output aria-label={label}>{desktop ? "wide" : "narrow"}</output>;
};

const mountView = (label: string) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const unmount = () => {
    flushSync(() => root.unmount());
    container.remove();
    cleanups.delete(unmount);
  };
  cleanups.add(unmount);
  flushSync(() => root.render(<ViewportView label={label} />));
  return { container, unmount };
};

beforeEach(() => resize(narrowWidth));
afterEach(() => {
  for (const cleanup of cleanups) {
    cleanup();
  }
  cleanups.clear();
  resize(originalViewport.width, originalViewport.height);
});

it("updates the product snapshot and a mounted view in both directions across 768px", () => {
  const view = mountView("product viewport");
  expect(productViewport.getSnapshot()).toBe(false);
  expect(view.container.querySelector("output")?.textContent).toBe("narrow");

  resize(desktopWidth);
  expect(productViewport.getSnapshot()).toBe(true);
  expect(view.container.querySelector("output")?.textContent).toBe("wide");

  resize(narrowWidth);
  expect(productViewport.getSnapshot()).toBe(false);
  expect(view.container.querySelector("output")?.textContent).toBe("narrow");
});

it("stops notifying a disposed subscriber while native viewport changes continue", () => {
  const witness = mountView("remaining viewport");
  const deliveredSnapshots: boolean[] = [];
  const dispose = productViewport.subscribe(() => {
    deliveredSnapshots.push(productViewport.getSnapshot());
  });
  cleanups.add(dispose);

  resize(desktopWidth);
  resize(narrowWidth);
  expect(deliveredSnapshots).toEqual([true, false]);

  dispose();
  cleanups.delete(dispose);
  resize(desktopWidth);
  expect(productViewport.getSnapshot()).toBe(true);
  expect(witness.container.querySelector("output")?.textContent).toBe("wide");
  expect(deliveredSnapshots).toEqual([true, false]);

  resize(narrowWidth);
  expect(productViewport.getSnapshot()).toBe(false);
  expect(witness.container.querySelector("output")?.textContent).toBe("narrow");
  expect(deliveredSnapshots).toEqual([true, false]);
});

it("keeps another mounted product view responsive after one view unmounts", () => {
  const first = mountView("first product viewport");
  const second = mountView("second product viewport");
  expect(first.container.querySelector("output")?.textContent).toBe("narrow");
  expect(second.container.querySelector("output")?.textContent).toBe("narrow");

  resize(desktopWidth);
  expect(first.container.querySelector("output")?.textContent).toBe("wide");
  expect(second.container.querySelector("output")?.textContent).toBe("wide");

  first.unmount();
  expect(first.container.isConnected).toBe(false);
  resize(narrowWidth);
  expect(second.container.querySelector("output")?.textContent).toBe("narrow");
  resize(desktopWidth);
  expect(second.container.querySelector("output")?.textContent).toBe("wide");

  second.unmount();
  expect(second.container.isConnected).toBe(false);
  resize(narrowWidth);
  expect(productViewport.getSnapshot()).toBe(false);
});
