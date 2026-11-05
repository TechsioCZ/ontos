import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { productViewport } from "../src/features/product-viewport";

afterEach(() => {
  rs.unstubAllGlobals();
});

describe("N1 product viewport subscription", () => {
  it("tracks the actual md media query and removes precisely its listener", () => {
    let desktop = false;
    const listeners = new Set<() => void>();
    const addEventListener = rs.fn((event: string, listener: () => void) => {
      expect(event).toBe("change");
      listeners.add(listener);
    });
    const removeEventListener = rs.fn((event: string, listener: () => void) => {
      expect(event).toBe("change");
      listeners.delete(listener);
    });
    const matchMedia = rs.fn((query: string) => {
      expect(query).toBe("(min-width: 768px)");
      return {
        addEventListener,
        get matches() {
          return desktop;
        },
        removeEventListener,
      };
    });
    rs.stubGlobal("window", { matchMedia });
    const changes = rs.fn<() => void>();
    const cleanup = productViewport.subscribe(changes);
    expect(productViewport.getSnapshot()).toBe(false);
    desktop = true;
    for (const listener of listeners) {
      listener();
    }
    expect(productViewport.getSnapshot()).toBe(true);
    expect(changes).toHaveBeenCalledTimes(1);
    desktop = false;
    for (const listener of listeners) {
      listener();
    }
    expect(productViewport.getSnapshot()).toBe(false);
    expect(changes).toHaveBeenCalledTimes(2);
    cleanup();
    expect(listeners.size).toBe(0);
    expect(removeEventListener).toHaveBeenCalledWith("change", changes);
  });
  it("cleans up one subscriber without dropping another mounted view", () => {
    const listeners = new Set<() => void>();
    rs.stubGlobal("window", {
      matchMedia: () => ({
        addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
        matches: true,
        removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
      }),
    });
    const first = rs.fn<() => void>();
    const second = rs.fn<() => void>();
    const removeFirst = productViewport.subscribe(first);
    const removeSecond = productViewport.subscribe(second);
    removeFirst();
    for (const listener of listeners) {
      listener();
    }
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    removeSecond();
    expect(listeners.size).toBe(0);
  });
});
