import { passwordResetCookie, portalRequest } from "@/ontos/account";
import { requestOrigin } from "@/ontos/http";
import { DEFAULT_MARKET_LOCALE } from "@/ontos/market-locale";

/**
 * Password mail links terminate here. The owner validates the token; a valid one moves into an HttpOnly
 * cookie, so it never appears in a page URL. Only the fixed same-origin landing page is returned.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  const origin = requestOrigin(request);
  let accepted = false;
  if (token.length <= 2048 && /^[\w.~-]+$/u.test(token)) {
    try {
      const response = await portalRequest(
        `/reset-password/${encodeURIComponent(token)}`,
        origin,
        null,
      );
      if (response.ok) {
        const result = (await response.json()) as { outcome?: string };
        accepted = result.outcome === "PASSWORD_RESET_PENDING";
      }
    } catch {
      // Provider details never enter the URL, page or logs; the form then reports the missing link.
      accepted = false;
    }
  }
  const headers = new Headers({
    location: `${origin}/${DEFAULT_MARKET_LOCALE}/obnova-hesla`,
    "cache-control": "no-store",
    pragma: "no-cache",
    "referrer-policy": "no-referrer",
  });
  headers.append("set-cookie", passwordResetCookie(origin, accepted ? token : null));
  return new Response(null, { status: 303, headers });
}
