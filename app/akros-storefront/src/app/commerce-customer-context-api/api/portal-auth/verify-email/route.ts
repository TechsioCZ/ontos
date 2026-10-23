import { portalRequest } from "@/ontos/account";

/** Mail links terminate here; the typed owner recovery route alone may consume their token. */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const tokens = url.searchParams.getAll("token");
  const token = tokens[0];
  let status = "neplatne";
  if (tokens.length === 1 && token && token.length <= 2048) {
    try {
      // Do not relay callbackURL or browser cookies. Verification grants no session, and the
      // fixed, same-origin landing prevents an email link from becoming an open redirect.
      const response = await portalRequest(
        `/verify-email?${new URLSearchParams({ token })}`,
        url.origin,
        null,
      );
      if (response.ok) {
        const result: unknown = await response.json();
        status =
          typeof result === "object" && result !== null && "outcome" in result
            ? result.outcome === "EMAIL_VERIFICATION_COMPLETED_SAME_SUBJECT"
              ? "overeno"
              : result.outcome === "ACCOUNT_RECOVERY_RECONCILIATION_REQUIRED"
                ? "podpora"
                : "nedostupne"
            : "nedostupne";
      } else if (response.status === 429) {
        status = "limit";
      } else if (response.status !== 400) {
        status = "nedostupne";
      }
    } catch {
      // Provider details and credentials never enter the URL, page or logs.
      status = "nedostupne";
    }
  }
  return new Response(null, {
    status: 303,
    headers: {
      location: `${url.origin}/overeni-emailu?${new URLSearchParams({ stav: status })}`,
      "cache-control": "no-store",
      pragma: "no-cache",
      "referrer-policy": "no-referrer",
    },
  });
}
