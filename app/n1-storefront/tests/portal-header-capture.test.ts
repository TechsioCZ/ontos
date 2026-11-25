import { afterEach, rs } from "@rstest/core";
import { Context, Effect, Fiber } from "effect";
import { FetchHttpClient } from "effect/http";
import { describe, expect, it } from "effect-rstest";
import { createOperation, RESPONSE_BYTES } from "@ontos/storefront-runtime";
import { storefrontHttpClientLayer, withOwnerOperation } from "../src/ontos/owner-operation";
import { portalRequestContext, readPortalOwnProfile } from "../src/ontos/portal-server";
import { portalWeb } from "../src/ontos/portal-http";

afterEach(() => {
  rs.unstubAllEnvs();
});

describe("Portal cookies at native header receipt", () => {
  it("applies captured cookies to the browser response even when native body bounds fail", async () => {
    rs.stubEnv("ONTOS_N1_STOREFRONT_API_KEY", "header-test");
    rs.stubEnv("ONTOS_STOREFRONT_LEGAL_ENTITY_ID", "71000000-0000-4000-8000-000000000099");
    rs.stubEnv("ONTOS_STOREFRONT_TENANT_ID", "70000000-0000-4000-8000-000000000099");
    rs.stubEnv("ONTOS_SHELL_URL", "https://shell.example");
    let writes = 0;
    const fetch: typeof globalThis.fetch = (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/gateway-context")) {
        return Promise.resolve(
          Response.json({
            apiBaseUrl: "/shell-super-app-api/module-api/owner",
            compositionRevision: "a".repeat(64),
            expiresAt: 99,
            token: "once",
          }),
        );
      }
      writes += 1;
      const headers = new Headers({ "content-type": "application/json" });
      headers.append("set-cookie", "commerce-portal.session_token=; HttpOnly; Path=/; Max-Age=0");
      headers.append("set-cookie", "staff.session=forbidden; HttpOnly; Path=/");
      return Promise.resolve(new Response("x".repeat(RESPONSE_BYTES + 1), { headers }));
    };
    const response = await portalWeb.handler(
      new Request("https://n1.example/api/account/logout", {
        body: "{}",
        headers: { "content-type": "application/json", origin: "https://n1.example" },
        method: "POST",
      }),
      Context.make(FetchHttpClient.Fetch, fetch),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "body_oversize" });
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("set-cookie")).not.toContain("forbidden");
    expect(writes).toBe(1);
  });

  for (const bodyKind of ["stalled", "oversized"] as const) {
    it.effect(`retains allowed rotations and revocations when the body is ${bodyKind}`, () => {
      const context = portalRequestContext(
        "https://n1.example",
        "staff.session=private; commerce-portal.session_token=old; commerce-portal.two_factor=old",
      );
      const supplied = Promise.withResolvers<null>();
      const closed = Promise.withResolvers<null>();
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/gateway-context")) {
          return Response.json({
            apiBaseUrl: "/shell-super-app-api/module-api/owner",
            compositionRevision: "a".repeat(64),
            expiresAt: 99,
            token: "once",
          });
        }
        const headers = new Headers({ "content-type": "application/json" });
        for (const cookie of [
          "commerce-portal.session_token=new; HttpOnly; Path=/; SameSite=Lax",
          "commerce-portal.two_factor=; HttpOnly; Path=/; Max-Age=0",
          "staff.session=forbidden; HttpOnly; Path=/",
          "commerce-portal.foreign=forbidden; Domain=example; Path=/",
        ]) {
          headers.append("set-cookie", cookie);
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              closed.resolve(null);
            },
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  bodyKind === "oversized" ? "x".repeat(RESPONSE_BYTES + 1) : '{"value":',
                ),
              );
              supplied.resolve(null);
            },
          }),
          { headers },
        );
      };
      const config = {
        apiKey: "header-test",
        appId: "n1-storefront",
        legalEntityId: "71000000-0000-4000-8000-000000000099",
        shellUrl: "https://shell.example",
        tenantId: "70000000-0000-4000-8000-000000000099",
      };
      return Effect.gen(function* nativeHeaderCapture() {
        const operation = yield* Effect.acquireRelease(createOperation(), (current) =>
          Effect.sync(current.dispose),
        );
        const pending = yield* Effect.forkChild(
          withOwnerOperation(readPortalOwnProfile(config, context), { operation }).pipe(
            Effect.exit,
          ),
        );
        yield* Effect.promise(() => supplied.promise);
        yield* Effect.yieldNow;
        if (bodyKind === "stalled") {
          expect(context.cookie).toBe("commerce-portal.session_token=new");
          operation.abort("deadline");
        }
        yield* Fiber.join(pending);
        expect(context.setCookies).toHaveLength(2);
        expect(context.setCookies.join(";")).toContain("Max-Age=0");
        expect(context.setCookies.join(";")).not.toContain("forbidden");
        expect(context.cookie).toBe("commerce-portal.session_token=new");
        yield* Effect.promise(() => closed.promise);
      }).pipe(
        Effect.scoped,
        Effect.provide(storefrontHttpClientLayer),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      );
    });
  }
});
