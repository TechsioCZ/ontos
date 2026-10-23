import { readCustomerProfile, saveCustomerProfile } from "@/ontos/customer-profile";
import { OntosError } from "@/ontos/gateway";
import { guard, jsonBody, problem, RequestError } from "@/ontos/http";
import { profileInput } from "@/ontos/profile-model";

const noStore = { "cache-control": "no-store" };
const anonymous = () =>
  Response.json(
    { message: "Pro úpravu údajů se prosím přihlaste." },
    { headers: noStore, status: 401 },
  );

export async function GET(request: Request) {
  try {
    return Response.json(
      await readCustomerProfile(new URL(request.url).origin, request.headers.get("cookie")),
      { headers: noStore },
    );
  } catch (error) {
    if (error instanceof OntosError && error.status === 401) {
      return anonymous();
    }
    return problem(error, "Údaje účtu se nepodařilo načíst z OntOS. Zkuste to prosím později.");
  }
}

export async function POST(request: Request) {
  try {
    guard(request);
    const { origin } = new URL(request.url);
    if (request.headers.get("origin") !== origin) {
      throw new RequestError(403, "Požadavek musí pocházet z tohoto obchodu.");
    }
    const input = profileInput(await jsonBody(request));
    if (!input) {
      throw new RequestError(400, "Zkontrolujte jméno, telefon a kontaktní e-mail.");
    }
    // The owner admits the live session and resolves its Party. Body identities are discarded.
    const profile = await saveCustomerProfile(origin, request.headers.get("cookie"), input);
    return Response.json({ outcome: "PROFILE_SAVED", profile }, { headers: noStore });
  } catch (error) {
    if (error instanceof OntosError && error.status === 401) {
      return anonymous();
    }
    if (error instanceof OntosError && [400, 403, 409, 422].includes(error.status)) {
      const message =
        error.status === 409
          ? "Údaje mezitím někdo změnil. Obnovte stránku a zkuste to znovu."
          : "OntOS změnu odmítl. Zkontrolujte údaje a oprávnění, potom zkuste uložení znovu.";
      return Response.json({ message }, { headers: noStore, status: error.status });
    }
    return problem(
      error,
      "Uložení se nepodařilo dokončit. Část změn mohla být uložena. Obnovte stránku a zkontrolujte údaje v OntOS.",
    );
  }
}
