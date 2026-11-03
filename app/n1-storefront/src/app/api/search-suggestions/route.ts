import { readSearchSuggestions } from "@/ontos/search-suggestions";

export const dynamic = "force-dynamic";

/** Read-only channel adapter. The owner query and server-held identity remain unchanged. */
export const GET = async (request: Request) => {
  const url = new URL(request.url);
  const result = await readSearchSuggestions(
    url.searchParams.get("locale") ?? "",
    url.searchParams.get("q") ?? "",
  );
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
};
