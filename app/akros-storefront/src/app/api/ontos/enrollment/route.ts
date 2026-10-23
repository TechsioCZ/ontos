import "server-only";
import { accountMessage, portalRequest } from "@/ontos/account";
import { guard, jsonBody, problem, RequestError } from "@/ontos/http";

const noStore = { "cache-control": "no-store" };
const states = [
  "IN_PROGRESS",
  "VERIFICATION_REQUIRED",
  "COMPLETE",
  "RECONCILIATION_REQUIRED",
  "TERMINATED",
  "FAILED",
];

async function progress(request: Request, operation: "read" | "resume" | "restart") {
  try {
    const url = new URL(request.url);
    if (url.search) throw new RequestError(400, "Požadavek nesmí obsahovat identifikátor účtu.");
    if (operation !== "read") {
      guard(request);
      if (request.headers.get("origin") !== url.origin)
        throw new RequestError(403, "Požadavek musí pocházet z tohoto obchodu.");
      const body: unknown = await jsonBody(request);
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length !== 0
      )
        throw new RequestError(400, "Požadavek nesmí obsahovat identifikátor účtu.");
    }
    const cookie = request.headers.get("cookie");
    // A created provider session is not customer admission. Recheck the real account each time.
    const admitted = await portalRequest("/customer-account", url.origin, cookie);
    if (admitted.ok) {
      const account = (await admitted.json()) as { state?: string };
      if (account.state === "authenticated")
        return Response.json({ state: "ADMITTED" }, { headers: noStore });
    } else if (admitted.status !== 401 && admitted.status !== 403) {
      return Response.json(
        { message: accountMessage(admitted.status) },
        { status: admitted.status, headers: noStore },
      );
    }
    const response = await portalRequest(
      operation === "read" ? "/enrollment/current" : `/enrollment/current/${operation}`,
      url.origin,
      cookie,
      operation === "read" ? undefined : {},
    );
    if (!response.ok)
      return Response.json(
        {
          message:
            response.status === 404
              ? "Pro tento účet není dostupná registrace v tomto obchodě."
              : response.status === 401
                ? "Pro zobrazení registrace se přihlaste ověřeným účtem."
                : accountMessage(response.status),
        },
        { status: response.status, headers: noStore },
      );
    const result = (await response.json()) as { state?: string; revision?: number };
    if (!result.state || !states.includes(result.state) || !Number.isInteger(result.revision))
      throw new Error("Enrollment progress response is malformed");
    // Never forward Attempt/Party/provider identifiers or private owner failure evidence.
    return Response.json({ state: result.state, revision: result.revision }, { headers: noStore });
  } catch (error) {
    return problem(error, accountMessage(503));
  }
}

export const GET = (request: Request) => progress(request, "read");
export const POST = (request: Request) => progress(request, "resume");

export const PUT = (request: Request) => progress(request, "restart");
