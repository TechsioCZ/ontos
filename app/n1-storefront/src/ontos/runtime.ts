import { storefrontHttpClientLayer } from "./owner-operation";
import "server-only";
import { Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";

/** One server runtime captured by Next's Promise adapters; owner operations retain typed Effects. */
export const storefrontRuntime = ManagedRuntime.make(
  storefrontHttpClientLayer.pipe(
    Layer.provide(
      Layer.succeed(FetchHttpClient.RequestInit, { cache: "no-store", redirect: "manual" }),
    ),
  ),
);
