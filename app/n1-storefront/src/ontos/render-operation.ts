import "server-only";
import { cache } from "react";
import { Fiber, Layer, ManagedRuntime } from "effect";
import { after } from "next/server";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";
import { createOperation } from "@ontos/storefront-runtime";

export const hasRenderLifetime = () =>
  workAsyncStorage.getStore() !== undefined && workUnitAsyncStorage.getStore() !== undefined;

/** One deadline across all owner chains of a React server render, never process-wide request state. */
const lifetimeRuntime = ManagedRuntime.make(Layer.empty);
export const renderOperation = cache(async () => {
  const operation = await lifetimeRuntime.runPromise(createOperation());
  if (hasRenderLifetime()) {
    after(async () => {
      await lifetimeRuntime.runPromise(Fiber.join(operation.dispose()));
    });
  }
  return operation;
});
