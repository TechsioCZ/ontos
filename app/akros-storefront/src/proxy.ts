import { NextResponse, type NextRequest } from "next/server";
import { hasCredentialQuery } from "@/ontos/credential-url";

export function proxy(request: NextRequest) {
  if (!hasCredentialQuery(request.nextUrl)) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = "/prihlaseni";
  url.search = "";
  const response = NextResponse.redirect(url, 303);
  response.headers.set("cache-control", "no-store");
  response.headers.set("referrer-policy", "no-referrer");
  return response;
}
