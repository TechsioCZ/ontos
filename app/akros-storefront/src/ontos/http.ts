import "server-only";
import { dictionaryFor, type Dictionary } from "@/i18n";
import { cs } from "@/i18n/cs";
import { MARKET_LOCALE_HEADER } from "./market-locale";

const isError = (value: unknown): value is Error =>
  value !== null && value !== undefined && Error.prototype.isPrototypeOf(value);

/** A request the BFF refuses on its own (not an OntOS outage): sent back with its own status. */
export class RequestError extends Error {
  static is(value: unknown): value is RequestError {
    return value !== null && value !== undefined && RequestError.prototype.isPrototypeOf(value);
  }

  constructor(
    readonly status: 400 | 403 | 404 | 409 | 413 | 415,
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
/**
 * Dictionary of a market locale for server messages: no locale (a request without the market header) keeps the
 * Czech wording, an unknown locale gets English (`dictionaryFor`). The locale only picks wording, never a market.
 */
export const localeDictionary = (locale: string | null | undefined): Dictionary =>
  locale ? dictionaryFor(locale) : cs;
/** Dictionary for the messages of this request: the browser sends the market locale with every API call. */
export const requestDictionary = (request: Request): Dictionary =>
  localeDictionary(request.headers.get(MARKET_LOCALE_HEADER));
export function guard(request: Request, t: Dictionary = requestDictionary(request)) {
  const origin = request.headers.get("origin");
  if (origin && origin !== requestOrigin(request))
    throw new RequestError(403, t.server.request.foreignOrigin);
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new RequestError(415, t.server.request.invalidFormat);
  if (Number(request.headers.get("content-length") ?? 0) > 100_000)
    throw new RequestError(413, t.server.request.tooLarge);
}
export async function jsonBody(request: Request, t: Dictionary = requestDictionary(request)) {
  const text = await request.text();
  if (text.length > 100_000) throw new RequestError(413, t.server.request.tooLarge);
  try {
    return JSON.parse(text);
  } catch {
    throw new RequestError(400, t.server.request.invalidFormat);
  }
}
/** `message`: the route's localized fallback text for a real OntOS failure (`t.server.outage.*`). */
export function problem(error: unknown, message: string) {
  if (RequestError.is(error))
    return Response.json(
      { message: error.message },
      { status: error.status, headers: { "cache-control": "no-store" } },
    );
  console.error("[AKROS]", isError(error) ? error.message : "Request failed");
  return Response.json({ message }, { status: 503, headers: { "cache-control": "no-store" } });
}
