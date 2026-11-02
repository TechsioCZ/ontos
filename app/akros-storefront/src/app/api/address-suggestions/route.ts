import {
  isSmartAddressCountry,
  parseAddressSuggestions,
  smartAddressParams,
} from "@/lib/smart-address";

const provider = "https://smart-suggest-shell-super-app.edution.workers.dev/api/v1/suggest";

/**
 * Same-origin proxy of the public Smart Suggest address API. Keep deployment authentication at our boundary: only
 * `q` and a supported `countryCode` (default CZ) are forwarded, never customer headers or other query options.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const query = params.get("q")?.trim() ?? "";
  const country = params.get("countryCode")?.trim().toUpperCase() || "CZ";
  const headers = { "Cache-Control": "no-store" };
  if (query.length < 3 || query.length > 300 || !isSmartAddressCountry(country))
    return Response.json({ error: "Invalid address query" }, { status: 400, headers });

  const upstream = new URL(provider);
  upstream.search = smartAddressParams(query, country).toString();
  try {
    const response = await fetch(upstream, {
      headers: { Accept: "application/json" },
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(8000)]),
    });
    if (!response.ok) throw new Error("Address provider unavailable");
    const suggestions = parseAddressSuggestions(await response.json(), country);
    return Response.json({ suggestions }, { headers });
  } catch {
    return Response.json({ error: "Address service unavailable" }, { status: 502, headers });
  }
}
