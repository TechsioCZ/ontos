import "server-only";
import { portalRequest } from "@/ontos/account";
import type { Dictionary } from "@/i18n";
import {
  guard,
  jsonBody,
  problem,
  RequestError,
  requestDictionary,
  requestOrigin,
} from "@/ontos/http";
import { passwordChangeInput } from "@/ontos/password-change-model";

const noStore = { "cache-control": "no-store" };

/** The owner's message for a refusal, in the request's language; the owner's raw body never reaches the browser. */
function refusal(status: number, t: Dictionary, code: string | undefined) {
  const messages = t.server.password;
  if (code === "current_password_invalid") return messages.currentInvalid;
  if (status === 401) return messages.signIn;
  if (status === 429) return messages.rateLimited;
  if (status === 400) return messages.invalid;
  if (status === 403) return messages.refused;
  return messages.unavailable;
}

async function ownerCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { code?: unknown };
    return typeof body.code === "string" ? body.code : undefined;
  } catch {
    return undefined;
  }
}

export async function POST(request: Request) {
  const t = requestDictionary(request);
  try {
    guard(request, t);
    const origin = requestOrigin(request);
    if (request.headers.get("origin") !== origin) {
      throw new RequestError(403, t.server.request.foreignOrigin);
    }
    const input = passwordChangeInput(await jsonBody(request, t));
    if (!input) {
      throw new RequestError(400, t.server.password.invalid);
    }
    // The owner admits the live session, verifies the current password and never echoes either password.
    const response = await portalRequest(
      "/change-password",
      origin,
      request.headers.get("cookie"),
      input,
    );
    if (response.ok) {
      return Response.json({ outcome: "PASSWORD_CHANGED" }, { headers: noStore });
    }
    const status = [400, 401, 403, 429].includes(response.status) ? response.status : 503;
    const message = refusal(status, t, await ownerCode(response));
    return Response.json({ message }, { headers: noStore, status });
  } catch (error) {
    return problem(error, t.server.password.unavailable);
  }
}
