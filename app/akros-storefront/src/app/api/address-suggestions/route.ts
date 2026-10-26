import { parseAddressSuggestions } from "@/lib/smart-address";

/** Keep deployment authentication at our boundary; never forward customer headers upstream. */
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  const headers = { "Cache-Control": "no-store" };
  if (query.length < 3 || query.length > 300)
    return Response.json({ error: "Invalid address query" }, { status: 400, headers });

  const upstream = new URL(
    "https://smart-suggest-shell-super-app.edution.workers.dev/api/v1/suggest",
  );
  upstream.search = new URLSearchParams({
    q: query,
    countryCode: "CZ",
    countryCodes: "CZ",
    kind: "address",
    language: "cs",
    limit: "20",
  }).toString();
  try {
    const response = await fetch(upstream, {
      headers: { Accept: "application/json" },
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(8000)]),
    });
    if (!response.ok) throw new Error("Address provider unavailable");
    const suggestions = parseAddressSuggestions(await response.json());
    return Response.json({ suggestions }, { headers });
  } catch {
    return Response.json({ error: "Address service unavailable" }, { status: 502, headers });
  }
}
