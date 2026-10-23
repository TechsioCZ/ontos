import "server-only";
import { portalRequest } from "@/ontos/account";
import { customerConsentInput, isCustomerNewsletterConsent } from "@/ontos/consent-model";
import { guard, jsonBody, problem, RequestError } from "@/ontos/http";

const noStore = { "cache-control": "no-store" };
async function ownerResponse(response: Response) {
  if (!response.ok) {
    const status = [400, 401, 403, 409].includes(response.status) ? response.status : 503;
    const message =
      status === 401
        ? "Pro správu newsletteru se prosím přihlaste."
        : status === 409
          ? "Informace o souhlasu se změnily. Načtěte aktuální znění znovu."
          : "OntOS teď nemůže potvrdit stav souhlasu. Zkuste načíst aktuální stav znovu.";
    return Response.json({ message }, { headers: noStore, status });
  }
  const consent: unknown = await response.json();
  if (!isCustomerNewsletterConsent(consent))
    throw new Error("Consent owner returned an invalid projection");
  return Response.json({ consent }, { headers: noStore });
}
export async function GET(request: Request) {
  try {
    return await ownerResponse(
      await portalRequest(
        "/customer-consent",
        new URL(request.url).origin,
        request.headers.get("cookie"),
      ),
    );
  } catch (error) {
    return problem(error, "Souhlas s newsletterem se nepodařilo načíst z OntOS.");
  }
}
export async function POST(request: Request) {
  try {
    guard(request);
    const { origin } = new URL(request.url);
    if (request.headers.get("origin") !== origin)
      throw new RequestError(403, "Požadavek musí pocházet z tohoto obchodu.");
    const input = customerConsentInput(await jsonBody(request));
    if (!input) throw new RequestError(400, "Potvrďte aktuální informace o souhlasu a svou volbu.");
    return await ownerResponse(
      await portalRequest("/customer-consent", origin, request.headers.get("cookie"), input),
    );
  } catch (error) {
    return problem(error, "Změnu souhlasu nelze potvrdit. Načtěte aktuální stav z OntOS znovu.");
  }
}
