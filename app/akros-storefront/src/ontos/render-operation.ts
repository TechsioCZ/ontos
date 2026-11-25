import { Effect, Fiber } from "effect";
import "server-only";
import { cache } from "react";
import { after } from "next/server";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";
import { createOperation } from "@ontos/storefront-runtime";

export const hasRenderLifetime = () =>
  workAsyncStorage.getStore() !== undefined && workUnitAsyncStorage.getStore() !== undefined;

/** React owns this holder per render. Outside React, a top-level caller must pass it to its whole chain. */
export const renderOperation = cache(() => {
  const operation = Effect.runSync(createOperation());
  if (hasRenderLifetime())
    after(async () => {
      await Effect.runPromise(Fiber.join(operation.dispose()));
    });
  return operation;
});
