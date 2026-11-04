import "server-only";
import { getBrand } from "@/brand";
import { portalRequest } from "@/ontos/account";
import { customerConsentInput, isCustomerNewsletterConsent } from "@/ontos/consent-model";
import type { Dictionary } from "@/i18n";
import {
  guard,
  jsonBody,
  problem,
  RequestError,
  requestDictionary,
  requestOrigin,
} from "@/ontos/http";

const noStore = { "cache-control": "no-store" };
async function ownerResponse(response: Response, t: Dictionary) {
  if (!response.ok) {
    const status = [400, 401, 403, 409].includes(response.status) ? response.status : 503;
    const message =
      status === 401
        ? t.server.consent.signIn
        : status === 409
          ? t.server.consent.changed
          : t.server.consent.unconfirmed;
    return Response.json({ message }, { headers: noStore, status });
  }
  const owner: unknown = await response.json();
  if (!isCustomerNewsletterConsent(owner))
    throw new Error("Consent owner returned an invalid projection");
  // OntOS's demo notice is AKROS-worded; a brand with its own consent text shows that text instead.
  const { consentWording } = getBrand();
  const consent =
    consentWording === undefined
      ? owner
      : { ...owner, notice: { ...owner.notice, wording: consentWording } };
  return Response.json({ consent }, { headers: noStore });
}
export async function GET(request: Request) {
  const t = requestDictionary(request);
  try {
    return await ownerResponse(
      await portalRequest(
        "/customer-consent",
        requestOrigin(request),
        request.headers.get("cookie"),
      ),
      t,
    );
  } catch (error) {
    return problem(error, t.server.consent.loadFailed);
  }
}
export async function POST(request: Request) {
  const t = requestDictionary(request);
  try {
    guard(request, t);
    const origin = requestOrigin(request);
    if (request.headers.get("origin") !== origin)
      throw new RequestError(403, t.server.request.foreignOrigin);
    const input = customerConsentInput(await jsonBody(request, t));
    if (!input) throw new RequestError(400, t.server.consent.invalid);
    return await ownerResponse(
      await portalRequest("/customer-consent", origin, request.headers.get("cookie"), input),
      t,
    );
  } catch (error) {
    return problem(error, t.server.consent.saveFailed);
  }
}
