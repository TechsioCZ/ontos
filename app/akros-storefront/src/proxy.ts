import { NextResponse, type NextRequest } from "next/server";
import { hasCredentialQuery } from "@/ontos/credential-url";

export function proxy(request: NextRequest) {
  if (!hasCredentialQuery(request.nextUrl)) return NextResponse.next();
  // Next's standalone request URL can name its loopback listener behind Zerops. Stay browser-relative.
  const response = new NextResponse(null, { status: 303, headers: { location: "/prihlaseni" } });
  response.headers.set("cache-control", "no-store");
  response.headers.set("referrer-policy", "no-referrer");
  return response;
}
