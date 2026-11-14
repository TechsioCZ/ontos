"use client";

import { useEffect, useState } from "react";
import { Effect, Fiber } from "effect";
import type { SearchSuggestionsResult } from "@/ontos/search-contract";
import { readSearchPreview } from "@/ontos/search-client";
import { clientRuntime } from "@/ontos/client-runtime";

interface Snapshot {
  locale: string;
  query: string;
  result: SearchSuggestionsResult;
}

/** React boundary: cancel obsolete work and never display results for an older query. */
export const useSearchSuggestions = (locale: string, query: string) => {
  const q = query.trim();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  useEffect(() => {
    const url = new URL("/api/search-suggestions", window.location.origin);
    url.searchParams.set("locale", locale);
    url.searchParams.set("q", q);
    const request = Effect.sleep("250 millis").pipe(
      Effect.andThen(readSearchPreview(url.href)),
      Effect.match({
        onFailure: () => setSnapshot({ locale, query: q, result: { state: "unavailable" } }),
        onSuccess: (result) => setSnapshot({ locale, query: q, result }),
      }),
    );
    const fiber = clientRuntime.runFork(q.length === 0 ? Effect.void : request);
    return () => {
      clientRuntime.runFork(Fiber.interrupt(fiber));
    };
  }, [locale, q]);

  if (q.length === 0) {
    return { state: "idle" as const };
  }
  if (snapshot?.query !== q || snapshot.locale !== locale) {
    return { state: "loading" as const };
  }
  return snapshot.result;
};
