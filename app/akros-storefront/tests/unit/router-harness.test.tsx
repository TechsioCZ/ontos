import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { getCurrentAppRouterState } from "next/dist/client/components/app-router-instance";
import { NextRouter, flightResponse } from "../support/router";
import { browserAt, serveHttp } from "../support/http";

function ReadRoute() {
  const router = useRouter();
  return (
    <>
      <output>
        {usePathname()}|{useSearchParams().get("q")}|{typeof router.push}
      </output>
      <button
        onClick={() => {
          router.push("/destination");
          router.refresh();
        }}
      >
        Navigate
      </button>
    </>
  );
}
afterEach(cleanup);
it("hydrates the real Next navigation contexts", async () => {
  browserAt("http://localhost:3000/catalog?q=bolt");
  await act(async () => {
    render(
      <NextRouter>
        <ReadRoute />
      </NextRouter>,
    );
  });
  expect(screen.getByRole("status").textContent).toBe("/catalog|bolt|function");
});
it("sends a real Next navigation and exactly one refresh over HTTP", async () => {
  const reply = await flightResponse("arrived");
  const refreshArrived = Promise.withResolvers<void>();
  const network = await serveHttp((request) => {
    if (decodeURIComponent(request.headers.get("next-router-state-tree") ?? "").includes("refetch"))
      refreshArrived.resolve();
    return reply.clone();
  });
  try {
    browserAt(network.origin);
    render(
      <NextRouter>
        <ReadRoute />
      </NextRouter>,
    );
    await act(async () => {
      screen.getByText("Navigate").click();
      await refreshArrived.promise;
      await network.idle();
    });
    expect(getCurrentAppRouterState()?.canonicalUrl).toBe("/destination");
    await network.idle();
    expect(network.requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/destination",
      "/destination",
    ]);
    const refreshes = network.requests.filter((request) =>
      decodeURIComponent(request.headers.get("next-router-state-tree") ?? "").includes("refetch"),
    );
    expect(refreshes).toHaveLength(1);
  } finally {
    cleanup();
    await network.close();
  }
});
