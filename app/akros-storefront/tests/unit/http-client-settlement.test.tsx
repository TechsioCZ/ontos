import { cleanup, render, screen } from "@testing-library/react";
import { useEffect, useState } from "react";
import { expect, it } from "vitest";
import { browserAt, serveHttp } from "../support/http";

function ClientOperation() {
  const [phase, setPhase] = useState("initial");
  useEffect(() => {
    if (phase === "complete") return;
    void fetch(`/${phase}`)
      .then((response) => response.json())
      .then((body: { next: string }) => setPhase(body.next));
  }, [phase]);
  return <output>{phase}</output>;
}

it("settles pre-connection fetches, body consumption and React follow-ups without waiting for UI timers", async () => {
  const first = Promise.withResolvers<Response>();
  const arrived = Promise.withResolvers<void>();
  const network = await serveHttp((request) => {
    if (new URL(request.url).pathname === "/initial") {
      arrived.resolve();
      return first.promise;
    }
    return Response.json({ next: "complete" });
  });
  browserAt(network.origin);
  const uiTimer = window.setInterval(() => {}, 60_000);
  try {
    render(<ClientOperation />);
    // Start settlement before any request has reached the server.
    const settled = network.idle();
    await arrived.promise;
    first.resolve(Response.json({ next: "follow-up" }));
    await settled;
    expect(screen.getByRole("status").textContent).toBe("complete");
    expect(network.requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/initial",
      "/follow-up",
    ]);
  } finally {
    window.clearInterval(uiTimer);
    first.resolve(Response.json({ next: "complete" }));
    cleanup();
    await network.idle();
    await network.close();
  }
});
