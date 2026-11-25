import { beforeEach, expect, it, rs } from "@rstest/core";
import { Effect } from "effect";
import type { OperationFailure } from "@ontos/storefront-runtime";
import { passwordRecoveryWeb } from "../src/ontos/password-recovery-http";
import {
  acceptPasswordRecovery,
  recoveryCookieName,
  requestPasswordRecovery,
  resetPasswordRecovery,
} from "../src/ontos/password-recovery-server";
import { CurrentOperation } from "../src/ontos/owner-operation";

rs.mock("../src/ontos/password-recovery-server", { spy: true });

beforeEach(() => {
  rs.mocked(resetPasswordRecovery).mockReset();
  rs.mocked(requestPasswordRecovery).mockReset();
  rs.mocked(acceptPasswordRecovery).mockReset();
});
const failOperation = (kind: OperationFailure) =>
  Effect.gen(function* interruptedOwnerWrite() {
    const operation = yield* CurrentOperation;
    expect(operation).toBeDefined();
    operation?.abort(kind);
    return yield* Effect.never;
  });
const request = (path: "reset" | "request") =>
  new Request(`https://n1.example/api/account/password/${path}`, {
    body: JSON.stringify(
      path === "reset"
        ? { newPassword: "x".repeat(16), passwordConfirmation: "x".repeat(16) }
        : { email: "shopper@example.test" },
    ),
    headers: {
      "content-type": "application/json",
      cookie: `${recoveryCookieName}=private-reset-token`,
      origin: "https://n1.example",
    },
    method: "POST",
  });

for (const kind of ["cancelled", "deadline", "body_oversize"] as const) {
  it(`keeps reset ${kind} typed and clears the uncertain reset credential`, async () => {
    rs.mocked(resetPasswordRecovery).mockReturnValue(failOperation(kind));
    const response = await passwordRecoveryWeb.handler(request("reset"));
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("set-cookie")).toContain(`${recoveryCookieName}=`);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("set-cookie")).not.toContain("private-reset-token");
    expect(await response.json()).toMatchObject({
      _tag: "PasswordRecoveryUnavailableProblem",
      state: "unconfirmed",
      status: 503,
    });
    expect(resetPasswordRecovery).toHaveBeenCalledTimes(1);
  });
}

it("keeps an uncertain recovery request typed without deleting an unrelated reset token", async () => {
  rs.mocked(requestPasswordRecovery).mockReturnValue(failOperation("deadline"));
  const response = await passwordRecoveryWeb.handler(request("request"));
  expect(response.status).toBe(503);
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(await response.json()).toMatchObject({
    _tag: "PasswordRecoveryUnavailableProblem",
    state: "unconfirmed",
    status: 503,
  });
  expect(requestPasswordRecovery).toHaveBeenCalledTimes(1);
});

it("still redirects an interrupted callback safely and clears its token", async () => {
  rs.mocked(acceptPasswordRecovery).mockReturnValue(failOperation("deadline"));
  const response = await passwordRecoveryWeb.handler(
    new Request(
      "https://n1.example/commerce-customer-context-api/api/portal-auth/reset-password/private-reset-token",
    ),
  );
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/cs/obnova-hesla");
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(response.headers.get("set-cookie")).not.toContain("private-reset-token");
});
