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
const anonymous = (t: Dictionary) =>
  Response.json({ message: t.server.profile.signIn }, { headers: noStore, status: 401 });

export async function GET(request: Request) {
  const t = requestDictionary(request);
  try {
    return Response.json(
      await readCustomerProfile(requestOrigin(request), request.headers.get("cookie")),
      {
        headers: noStore,
      },
    );
  } catch (error) {
    if (OntosError.is(error) && error.status === 401) {
      return anonymous(t);
    }
    return problem(error, t.server.profile.loadFailed);
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
    const input = profileInput(await jsonBody(request, t));
    if (!input) {
      throw new RequestError(400, t.server.profile.invalid);
    }
    // The owner admits the live session and resolves its Party. Body identities are discarded.
    const profile = await saveCustomerProfile(origin, request.headers.get("cookie"), input);
    return Response.json({ outcome: "PROFILE_SAVED", profile }, { headers: noStore });
  } catch (error) {
    if (OntosError.is(error) && error.status === 401) {
      return anonymous(t);
    }
    if (OntosError.is(error) && [400, 403, 409, 422].includes(error.status)) {
      const message = error.status === 409 ? t.server.profile.conflict : t.server.profile.refused;
      return Response.json({ message }, { headers: noStore, status: error.status });
    }
    return problem(error, t.server.profile.saveUncertain);
  }
}
