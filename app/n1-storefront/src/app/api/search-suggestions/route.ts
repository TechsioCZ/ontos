import { Effect } from "effect";
import { CurrentOperation, withOwnerOperation } from "@/ontos/owner-operation";
import { readSearchSuggestions } from "@/ontos/search-suggestions";
import { storefrontRuntime } from "@/ontos/runtime";

export const dynamic = "force-dynamic";
const failureStatuses = {
  body_oversize: 502,
  cancelled: 499,
  deadline: 504,
  overloaded: 503,
} as const;

/** Read-only channel adapter. The owner query and server-held identity remain unchanged. */
export const GET = async (request: Request) =>
  await storefrontRuntime.runPromise(
    withOwnerOperation(
      Effect.gen(function* searchSuggestionsRequest() {
        const operation = yield* CurrentOperation;
        const url = new URL(request.url);
        return yield* Effect.promise(
          async () =>
            await readSearchSuggestions(
              url.searchParams.get("locale") ?? "",
              url.searchParams.get("q") ?? "",
              undefined,
              { operation },
            ),
        );
      }),
      { signal: request.signal },
    ).pipe(
      Effect.map((result) => Response.json(result, { headers: { "cache-control": "no-store" } })),
      Effect.catchTag("OperationError", (error) =>
        Effect.succeed(
          Response.json(
            { code: error.kind, state: "unavailable" },
            {
              headers: { "cache-control": "no-store" },
              status: failureStatuses[error.kind],
            },
          ),
        ),
      ),
    ),
  );
