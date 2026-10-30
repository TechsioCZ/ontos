import "server-only";

const isError = (value: unknown): value is Error =>
  value !== null && value !== undefined && Error.prototype.isPrototypeOf(value);

/** A request the BFF refuses on its own (not an OntOS outage): sent back with its own status. */
export class RequestError extends Error {
  static is(value: unknown): value is RequestError {
    return value !== null && value !== undefined && RequestError.prototype.isPrototypeOf(value);
  }

  constructor(
    readonly status: 400 | 403 | 404 | 413 | 415,
    message: string,
  ) {
    super(message);
  }
}
/**
 * The public origin the browser addressed. A standalone Next server behind a proxy builds `request.url` from the
 * address it listens on (https://0.0.0.0:3070 on Zerops), so the origin comes from the forwarded protocol and the
 * Host header, which the browser sets and the Zerops router routes by.
 */
export function requestOrigin(request: Request) {
  const url = new URL(request.url);
  const protocol =
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.slice(0, -1);
  return `${protocol}://${request.headers.get("host") ?? url.host}`;
}
export function guard(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== requestOrigin(request))
    throw new RequestError(403, "Požadavek musí pocházet z tohoto obchodu.");
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new RequestError(415, "Neplatný formát požadavku.");
  if (Number(request.headers.get("content-length") ?? 0) > 100_000)
    throw new RequestError(413, "Požadavek je příliš velký.");
}
export async function jsonBody(request: Request) {
  const text = await request.text();
  if (text.length > 100_000) throw new RequestError(413, "Požadavek je příliš velký.");
  try {
    return JSON.parse(text);
  } catch {
    throw new RequestError(400, "Neplatný formát požadavku.");
  }
}
/** Fallback texts for a real OntOS failure, per route (only the cart routes talk about the cart). */
export const outageMessage = {
  cart: "Spojení s OntOS se nepodařilo. Košík zůstává zachovaný. Zkuste to prosím znovu.",
  orderStatus: "Stav objednávky se teď nepodařilo z OntOS načíst. Zkuste to prosím za chvíli.",
  search: "Vyhledávání v OntOS je teď nedostupné. Zkuste to prosím za chvíli.",
} as const;
export function problem(error: unknown, message: string = outageMessage.cart) {
  if (RequestError.is(error))
    return Response.json(
      { message: error.message },
      { status: error.status, headers: { "cache-control": "no-store" } },
    );
  console.error("[AKROS]", isError(error) ? error.message : "Request failed");
  return Response.json({ message }, { status: 503, headers: { "cache-control": "no-store" } });
}
