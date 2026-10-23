import "server-only";
import {
  accountMessage,
  portalCookie,
  portalRequest,
  readAccount,
  registrationInput,
} from "@/ontos/account";
import { guard, jsonBody, problem, RequestError } from "@/ontos/http";

const noStore = { "cache-control": "no-store" };

export async function GET(request: Request) {
  try {
    const account = await readAccount(new URL(request.url).origin, request.headers.get("cookie"));
    return Response.json({ account }, { headers: noStore });
  } catch (error) {
    return problem(error, accountMessage(503));
  }
}

export async function POST(request: Request) {
  try {
    guard(request);
    const origin = new URL(request.url).origin;
    if (request.headers.get("origin") !== origin)
      throw new RequestError(403, "Požadavek musí pocházet z tohoto obchodu.");
    const input: unknown = await jsonBody(request);
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new RequestError(400, "Neplatný požadavek.");
    const data = input as Record<string, unknown>;
    let path: string;
    let body: unknown;
    let idempotencyKey: string | undefined;
    if (data.operation === "register") {
      path = "/enrollment/start";
      body = registrationInput(data);
      if (
        typeof data.requestId !== "string" ||
        !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(data.requestId)
      )
        throw new RequestError(400, "Chybí identifikátor registrace.");
      idempotencyKey = `storefront-enrollment:${data.requestId}`;
    } else if (data.operation === "login") {
      if (
        typeof data.email !== "string" ||
        typeof data.password !== "string" ||
        data.password.length > 128
      )
        throw new RequestError(400, "Zadejte e-mail a heslo.");
      path = "/sign-in/email";
      body = {
        email: data.email.trim().toLowerCase(),
        password: data.password,
        rememberMe: data.rememberMe === true,
      };
    } else if (data.operation === "logout") {
      path = "/sign-out";
      body = {};
    } else throw new RequestError(400, "Neznámý požadavek.");
    const response = await portalRequest(
      path,
      origin,
      request.headers.get("cookie"),
      body,
      idempotencyKey,
    );
    const result = (await response.json()) as { code?: string; outcome?: string };
    if (!response.ok)
      return Response.json(
        { message: accountMessage(response.status, result.code) },
        {
          status: response.status,
          headers: noStore,
        },
      );
    // Never return provider subjects, session references or credentials to browser JavaScript.
    const headers = new Headers(noStore);
    for (const cookie of response.headers.getSetCookie()) {
      if (portalCookie(cookie.split(";")[0] ?? null)) headers.append("set-cookie", cookie);
    }
    if (data.operation === "login" && result.outcome !== "SESSION_CREATED")
      return Response.json(
        { message: "Účet vyžaduje dvoufázové ověření v zákaznickém portálu." },
        { status: 403, headers: noStore },
      );
    if (
      data.operation === "register" &&
      result.outcome !== "CREATED" &&
      result.outcome !== "EXISTING"
    )
      throw new Error("Enrollment start was not acknowledged");
    return Response.json(
      {
        // The remaining governed owner transitions continue durably; this is not customer completion.
        outcome: data.operation === "register" ? "ENROLLMENT_STARTED" : result.outcome,
      },
      { headers },
    );
  } catch (error) {
    return problem(error, accountMessage(503));
  }
}
