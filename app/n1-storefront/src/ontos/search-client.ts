"use client";

import { Effect, Schema } from "effect";
import { HttpClient } from "effect/http";
import { SearchSuggestionsResponse } from "./search-contract";

/** Abortable HTTP read; keep the Effect program outside the React Compiler hook body. */
export const readSearchPreview = (url: string) =>
  Effect.gen(function* readSuggestions() {
    const client = yield* HttpClient.HttpClient;
    const response = yield* HttpClient.filterStatusOk(client).get(url);
    const body = yield* response.json;
    return yield* Schema.decodeUnknownEffect(SearchSuggestionsResponse)(body);
  });
