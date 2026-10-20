import "server-only";
import { isOntos } from "./config";
export function guard(request: Request) {
  if (!isOntos()) throw new Error("Připojení k OntOS není zapnuté.");
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin)
    throw new Error("Požadavek musí pocházet z tohoto obchodu.");
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new Error("Neplatný formát požadavku.");
  if (Number(request.headers.get("content-length") ?? 0) > 100_000)
    throw new Error("Požadavek je příliš velký.");
}
export async function jsonBody(request: Request) {
  const text = await request.text();
  if (text.length > 100_000) throw new Error("Požadavek je příliš velký.");
  return JSON.parse(text);
}
export function problem(error: unknown) {
  console.error("[AKROS]", error instanceof Error ? error.message : "Request failed");
  return Response.json(
    {
      message:
        "Spojení s OntOS se nepodařilo nebo požadavek není platný. Košík zůstává zachovaný. Zkuste to prosím znovu.",
    },
    { status: 503 },
  );
}
