import "server-only";
import { accountMessage, portalRequest } from "@/ontos/account";
import {
  guard,
  jsonBody,
  problem,
  RequestError,
  requestDictionary,
  requestOrigin,
} from "@/ontos/http";

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
  const t = requestDictionary(request);
  try {
    const url = new URL(request.url);
    if (url.search) throw new RequestError(400, t.server.request.noAccountIdentifier);
    if (operation !== "read") {
      guard(request, t);
      if (request.headers.get("origin") !== requestOrigin(request))
        throw new RequestError(403, t.server.request.foreignOrigin);
      const body: unknown = await jsonBody(request, t);
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length !== 0
      )
        throw new RequestError(400, t.server.request.noAccountIdentifier);
    }
    const cookie = request.headers.get("cookie");
    // A created provider session is not customer admission. Recheck the real account each time.
    const admitted = await portalRequest("/customer-account", requestOrigin(request), cookie);
    if (admitted.ok) {
      const account = (await admitted.json()) as { state?: string };
      if (account.state === "authenticated")
        return Response.json({ state: "ADMITTED" }, { headers: noStore });
    } else if (admitted.status !== 401 && admitted.status !== 403) {
      return Response.json(
        { message: accountMessage(t, admitted.status) },
        { status: admitted.status, headers: noStore },
      );
    }
    const response = await portalRequest(
      operation === "read" ? "/enrollment/current" : `/enrollment/current/${operation}`,
      requestOrigin(request),
      cookie,
      operation === "read" ? undefined : {},
    );
    if (!response.ok)
      return Response.json(
        {
          message:
            response.status === 404
              ? t.server.account.enrollmentNotFound
              : response.status === 401
                ? t.server.account.enrollmentSignIn
                : accountMessage(t, response.status),
        },
        { status: response.status, headers: noStore },
      );
    const result = (await response.json()) as { state?: string; revision?: number };
    if (!result.state || !states.includes(result.state) || !Number.isInteger(result.revision))
      throw new Error("Enrollment progress response is malformed");
    // Never forward Attempt/Party/provider identifiers or private owner failure evidence.
    return Response.json({ state: result.state, revision: result.revision }, { headers: noStore });
  } catch (error) {
    return problem(error, accountMessage(t, 503));
  }
}

export const GET = (request: Request) => progress(request, "read");
export const POST = (request: Request) => progress(request, "resume");

export const PUT = (request: Request) => progress(request, "restart");
