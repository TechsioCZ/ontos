import { Effect } from "effect";
import { createOperation } from "@ontos/storefront-runtime";
import { readCustomerProfile, saveCustomerProfile } from "@/ontos/customer-profile";
import { OntosError } from "@/ontos/gateway";
import type { Dictionary } from "@/i18n";
import {
  guard,
  jsonBody,
  problem,
  RequestError,
  requestDictionary,
  requestOrigin,
} from "@/ontos/http";
import { profileInput } from "@/ontos/profile-model";

const noStore = { "cache-control": "no-store" };
const anonymous = (t: Dictionary, responseHeaders: Headers) =>
  Response.json({ message: t.server.profile.signIn }, { headers: responseHeaders, status: 401 });

export async function GET(request: Request) {
  const t = requestDictionary(request);
  const responseHeaders = new Headers(noStore);
  const lifetime = Effect.runSync(createOperation({ signal: request.signal }));
  try {
    return Response.json(
      await readCustomerProfile(requestOrigin(request), request.headers.get("cookie"), {
        operation: lifetime,
        responseHeaders,
      }),
      {
        headers: responseHeaders,
      },
    );
  } catch (error) {
    if (OntosError.is(error) && error.status === 401) {
      return anonymous(t, responseHeaders);
    }
    return problem(error, t.server.profile.loadFailed, responseHeaders);
  } finally {
    lifetime.dispose();
  }
}

export async function POST(request: Request) {
  const t = requestDictionary(request);
  const responseHeaders = new Headers(noStore);
  const lifetime = Effect.runSync(createOperation({ signal: request.signal }));
  try {
    guard(request, t);
    const origin = requestOrigin(request);
    if (request.headers.get("origin") !== origin) {
      throw new RequestError(403, t.server.request.foreignOrigin);
    }
    const input = profileInput(await jsonBody(request, t, lifetime));
    if (!input) {
      throw new RequestError(400, t.server.profile.invalid);
    }
    // The owner admits the live session and resolves its Party. Body identities are discarded.
    const profile = await saveCustomerProfile(origin, request.headers.get("cookie"), input, {
      operation: lifetime,
      responseHeaders,
    });
    return Response.json({ outcome: "PROFILE_SAVED", profile }, { headers: responseHeaders });
  } catch (error) {
    if (OntosError.is(error) && error.status === 401) {
      return anonymous(t, responseHeaders);
    }
    if (OntosError.is(error) && [400, 403, 409, 422].includes(error.status)) {
      const message = error.status === 409 ? t.server.profile.conflict : t.server.profile.refused;
      return Response.json({ message }, { headers: responseHeaders, status: error.status });
    }
    return problem(error, t.server.profile.saveUncertain, responseHeaders);
  } finally {
    lifetime.dispose();
  }
}
