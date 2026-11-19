import { act } from "react";
import { setImmediate } from "node:timers/promises";
import { BrowserWindow, PropertySymbol } from "happy-dom";
import WindowBrowserContext from "happy-dom/lib/window/WindowBrowserContext.js";

/**
 * After the visible terminal result, observe native fetch/body completion and
 * commit React, including effects which launch more requests. The browser's
 * task count includes fetches before they connect and response body readers.
 * Whole-browser idleness cannot be used: focused controls, toasts and polling
 * deliberately retain timers after the operation has finished.
 */
export async function settleBrowser() {
  const nativeWindow: unknown = Reflect.get(document, PropertySymbol.window);
  const isBrowserWindow = (value: unknown): value is BrowserWindow =>
    value !== null && typeof value === "object" && BrowserWindow.prototype.isPrototypeOf(value);
  if (!isBrowserWindow(nativeWindow))
    throw new Error("Client request settlement requires a happy-dom window");
  const context = new WindowBrowserContext(nativeWindow);
  const tasks = context.getAsyncTaskManager();
  if (!tasks) throw new Error("Missing native browser task manager");
  do {
    await act(async () => {
      // This is a client-side terminal condition, not a guessed number of IO turns.
      while (tasks.getTaskCount() > 0) await setImmediate();
    });
    // Committing React effects can start another native request.
  } while (tasks.getTaskCount() > 0);
}
