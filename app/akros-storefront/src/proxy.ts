import { NextResponse, type NextRequest } from "next/server";
import { hasCredentialQuery } from "@/ontos/credential-url";
import { requestOrigin } from "@/ontos/http";

export function proxy(request: NextRequest) {
  if (!hasCredentialQuery(request.nextUrl)) return NextResponse.next();
  // Next's proxy adapter requires an absolute redirect, using the browser's origin rather than its loopback URL.
  const response = NextResponse.redirect(new URL("/prihlaseni", requestOrigin(request)), 303);
  response.headers.set("cache-control", "no-store");
  response.headers.set("referrer-policy", "no-referrer");
  return response;
}
