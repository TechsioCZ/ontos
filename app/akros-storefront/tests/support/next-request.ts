import "next/dist/server/node-environment-baseline";
import { NextRequest } from "next/server";
import { createRequestStoreForAPI } from "next/dist/server/async-storage/request-store";
import { createWorkStore } from "next/dist/server/async-storage/work-store";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";

/** The same request/work stores Next uses for headers(), cookies() and after(). */
export function nextRequest(url = "http://shop.test/", init?: RequestInit) {
  const request = new NextRequest(new Request(url, init));
  const closed: Array<() => void> = [];
  const pending: Promise<unknown>[] = [];
  const errors: unknown[] = [];
  const work = createWorkStore({
    page: "/test/route",
    deploymentId: "test",
    buildId: "test",
    previouslyRevalidatedTags: [],
    renderOpts: {
      cacheLifeProfiles: { default: { stale: 300, revalidate: 900, expire: 31_536_000 } },
      staticPageGenerationTimeout: 60,
      cacheComponents: false,
      validationLevel: "warning",
      experimental: {
        isRoutePPREnabled: false,
        authInterrupts: false,
        useCacheTimeout: 50_000,
        durableUseCacheEntries: false,
      },
      assetPrefix: "",
      isBuildTimePrerendering: false,
      isDraftMode: false,
      isDebugDynamicAccesses: false,
      waitUntil: (promise) => {
        pending.push(promise);
      },
      onClose: (callback) => {
        closed.push(callback);
      },
      onAfterTaskError: (error) => {
        errors.push(error);
      },
    },
  });
  const unit = createRequestStoreForAPI(
    request,
    new URL(url),
    {
      tags: [],
      expirationsByCacheKind: new Map(),
    },
    undefined,
    undefined,
    undefined,
  );
  return {
    request,
    run<T>(action: () => T): T {
      return workAsyncStorage.run(work, () => workUnitAsyncStorage.run(unit, action));
    },
    async close() {
      for (const callback of closed) callback();
      await Promise.all(pending);
      if (errors.length) throw errors[0];
    },
  };
}
