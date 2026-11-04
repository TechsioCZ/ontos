import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

/** Overwrite any browser-supplied locale header before root metadata is rendered. */
export const proxy = (request: NextRequest) => {
  const headers = new Headers(request.headers);
  headers.set("x-n1-locale", request.nextUrl.pathname.split("/")[1] === "en" ? "en" : "cs");
  headers.set("x-n1-request-origin", request.nextUrl.origin);
  return NextResponse.next({ request: { headers } });
};

export const config = { matcher: ["/((?!_next/static|_next/image|brand/|favicon.ico).*)"] };
