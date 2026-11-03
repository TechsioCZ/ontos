"use client";

import { Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";

/** Shared browser HTTP runtime. Interrupting a query fiber aborts its browser fetch. */
export const clientRuntime = ManagedRuntime.make(
  FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(FetchHttpClient.RequestInit, { cache: "no-store", redirect: "error" }),
    ),
  ),
);
