import { createServer } from "node:http";
import { setImmediate } from "node:timers/promises";
import {
  act,
  cleanup,
  fireEvent,
  render as renderComponent,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { EnrollmentProgress } from "@/components/enrollment-progress";
import { publicAppRouterInstance as router } from "next/dist/client/components/app-router-instance";
import { flightResponse, NextRouter } from "../support/router";
import { browserAt } from "../support/http";

const disconnect = Symbol("disconnect");
type HeldResponse = { response: Promise<Response> };
type Answer = Response | HeldResponse | typeof disconnect;
let network: Awaited<ReturnType<typeof serveEnrollment>>;
let answers: Answer[];
let answer: (request: Request) => Answer;
let fetchProgress: MockInstance<typeof fetch>;
let replaceAccount: MockInstance<typeof router.replace>;
let recoveryHistory: unknown;
let accountFlight: Response;

// Real server-side socket closure is the observable abort boundary, not a fabricated fetch signal.
async function serveEnrollment() {
  const requests: Request[] = [];
  const aborted = new Set<number>();
  const abortArrivals: Promise<void>[] = [];
  const held = new Set<Promise<Response>>();
  let holdArrival = Promise.withResolvers<void>();
  let active = 0;
  let moves = 0;
  const server = createServer(async (incoming, outgoing) => {
    active++;
    moves++;
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) {
        for (const item of value) headers.append(key, item);
      } else if (value !== undefined) headers.set(key, value);
    }
    const request = new Request(`${origin}${incoming.url}`, {
      method: incoming.method,
      headers,
      ...(chunks.length ? { body: Buffer.concat(chunks).toString() } : {}),
    });
    const index = requests.length;
    requests.push(request);
    abortArrivals.push(
      new Promise<void>((resolve) => {
        outgoing.on("close", () => {
          if (!outgoing.writableFinished) {
            aborted.add(index);
            resolve();
          }
        });
      }),
    );
    const selected =
      new URL(request.url).pathname === "/muj-ucet"
        ? accountFlight.clone()
        : (answers.shift() ?? answer(request));
    if (selected === disconnect) {
      outgoing.destroy();
      active--;
      moves++;
      return;
    }
    let response: Response;
    if (selected instanceof Response) response = selected;
    else {
      active--;
      moves++;
      held.add(selected.response);
      holdArrival.resolve();
      response = await selected.response;
      held.delete(selected.response);
      if (held.size === 0) holdArrival = Promise.withResolvers<void>();
      active++;
    }
    outgoing.writeHead(response.status, {
      ...Object.fromEntries(response.headers),
      "cache-control": "no-store",
    });
    outgoing.end(Buffer.from(await response.arrayBuffer()));
    active--;
    moves++;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing HTTP address");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    requests,
    aborted,
    abortArrivals,
    hasHeld: () => held.size !== 0,
    untilHeld: () => holdArrival.promise,
    async idle() {
      for (;;) {
        const before = moves;
        await setImmediate();
        await setImmediate();
        if (active === 0 && before === moves) return;
      }
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

const progressRequests = () =>
  network.requests.filter((request) => new URL(request.url).pathname === "/api/ontos/enrollment");
const accountRequests = () =>
  network.requests.filter((request) => new URL(request.url).pathname === "/muj-ucet");

function render(ui: React.ReactNode) {
  // Without a selected market, the real MarketContext deliberately uses Czech copy
  // and unprefixed links, matching a registration recovery outside a market route.
  const view = renderComponent(<NextRouter>{ui}</NextRouter>);
  recoveryHistory = window.history.state;
  return view;
}

async function settle() {
  await act(async () => {
    await network.idle();
    if (!network.hasHeld()) {
      await Promise.race([window.happyDOM.whenAsyncComplete(), network.untilHeld()]);
    }
  });
}

// Only the component's timeout clock is virtual; native fetch and loopback IO stay real.
async function advance(milliseconds: number) {
  await settle();
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    const step = Math.min(1_000, end - Date.now());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(step);
    });
    await settle();
  }
}

beforeAll(async () => {
  accountFlight = await flightResponse("Přihlášený účet");
});
beforeEach(async () => {
  // Observation only: every request still executes happy-dom's native fetch.
  fetchProgress = vi.spyOn(globalThis, "fetch");
  replaceAccount = vi.spyOn(router, "replace");
  answers = [];
  answer = () => Response.json({ message: "Unexpected enrollment request" }, { status: 500 });
  network = await serveEnrollment();
  browserAt(network.origin + "/prihlaseni");
});
afterEach(async () => {
  // Exercise Next's native Back/Forward restoration before the singleton router is reused.
  await act(async () => {
    window.history.replaceState(recoveryHistory, "", network.origin + "/prihlaseni");
    window.dispatchEvent(new PopStateEvent("popstate", { state: recoveryHistory }));
  });
  cleanup();
  fetchProgress.mockRestore();
  replaceAccount.mockRestore();
  vi.useRealTimers();
  await network.close();
});

it("recovers pending registration after a reload and resumes only on explicit request", async () => {
  answer = () => Response.json({ state: "RECONCILIATION_REQUIRED", revision: 10 });
  const view = render(<EnrollmentProgress />);
  const resume = await screen.findByRole("button", { name: "Obnovit registraci" });
  await settle();
  expect(progressRequests()).toHaveLength(1);
  await settle();
  expect(accountRequests()).toHaveLength(0);
  expect(router.replace).not.toHaveBeenCalled();
  fireEvent.click(resume);
  await waitFor(() => expect(progressRequests()).toHaveLength(2));
  await settle();
  expect(progressRequests()[1]?.method).toBe("POST");
  expect(await progressRequests()[1]?.text()).toBe("{}");
  view.unmount();
  render(<EnrollmentProgress />);
  await screen.findByRole("button", { name: "Obnovit registraci" });
  await settle();
  expect(progressRequests()).toHaveLength(3);
  expect(progressRequests()[2]?.method).toBe("GET");
  expect(fetchProgress.mock.calls[2]?.[1]).toMatchObject({ method: "GET", cache: "no-store" });
});

it.each(["FAILED", "TERMINATED", "COMPLETE"])(
  "does not offer to replay a terminal native Attempt (%s)",
  async (state) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    answer = () => Response.json({ state });
    render(<EnrollmentProgress />);
    await advance(10_000);
    expect(screen.getByRole("button", { name: "Ověřit stav" }).hasAttribute("disabled")).toBe(
      false,
    );
    expect(progressRequests().every((request) => request.method === "GET")).toBe(true);
    expect(screen.queryByRole("button", { name: "Obnovit registraci" })).toBeNull();
    await settle();
    expect(accountRequests()).toHaveLength(0);
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain(
      state === "COMPLETE" ? "přístup" : state === "FAILED" ? "nové přijetí" : "nelze ji obnovit",
    );
  },
);

it("opens the account only after real admission, not merely COMPLETE or SESSION_CREATED", async () => {
  answer = () => Response.json({ state: "ADMITTED" });
  render(<EnrollmentProgress />);
  await waitFor(() => expect(window.location.pathname).toBe("/muj-ucet"));
  await settle();
  expect(router.replace).toHaveBeenCalledWith("/muj-ucet");
});

it("shows owner authentication/outage refusals without automatic retry loops", async () => {
  answer = () => Response.json({ message: "Přihlaste se ověřeným účtem." }, { status: 401 });
  render(<EnrollmentProgress />);
  expect((await screen.findByRole("alert")).textContent).toContain("Přihlaste se");
  await settle();
  expect(progressRequests()).toHaveLength(1);
  await settle();
  expect(accountRequests()).toHaveLength(0);
  expect(router.replace).not.toHaveBeenCalled();
});

it("starts a new enrollment only on explicit FAILED restart, never repeating signup or the old Attempt", async () => {
  answer = (request) =>
    Response.json({ state: request.method === "PUT" ? "IN_PROGRESS" : "FAILED", revision: 2 });
  render(<EnrollmentProgress />);
  const restart = await screen.findByRole("button", { name: "Zahájit nové přijetí účtu" });
  await settle();
  expect(progressRequests()).toHaveLength(1);
  fireEvent.click(restart);
  await screen.findByRole("button", { name: "Obnovit registraci" });
  expect(progressRequests()[1]?.method).toBe("PUT");
  expect(await progressRequests()[1]?.text()).toBe("{}");
  expect(screen.queryByRole("button", { name: "Zahájit nové přijetí účtu" })).toBeNull();
  await settle();
  expect(accountRequests()).toHaveLength(0);
  expect(router.replace).not.toHaveBeenCalled();
});

it.each(["IN_PROGRESS", "VERIFICATION_REQUIRED"])(
  "automatically resumes %s once after login and checks real account admission before routing",
  async (state) => {
    answers.push(Response.json({ state, revision: 3 }));
    answers.push(Response.json({ state: "COMPLETE", revision: 12 }));
    answers.push(Response.json({ state: "ADMITTED" }));
    render(<EnrollmentProgress />);
    await waitFor(() => expect(window.location.pathname).toBe("/muj-ucet"));
    await settle();
    expect(router.replace).toHaveBeenCalledWith("/muj-ucet");
    await settle();
    expect(progressRequests()).toHaveLength(3);
    expect(progressRequests().map((request) => request.method)).toEqual(["GET", "POST", "GET"]);
    expect(await progressRequests()[1]?.text()).toBe("{}");
    expect(fetchProgress.mock.calls[1]?.[1]).toMatchObject({ body: "{}", cache: "no-store" });
  },
);

it("bounds read-only rechecks without treating persistent COMPLETE as admission or replaying resume", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  answer = () => Response.json({ state: "COMPLETE", revision: 12 });
  answers.push(Response.json({ state: "IN_PROGRESS", revision: 3 }));
  answers.push(Response.json({ state: "COMPLETE", revision: 12 }));
  render(<EnrollmentProgress />);
  await advance(10_000);
  await settle();
  expect(progressRequests()).toHaveLength(13);
  expect(progressRequests().filter((request) => request.method === "POST")).toHaveLength(1);
  await settle();
  expect(accountRequests()).toHaveLength(0);
  expect(router.replace).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Obnovit registraci" })).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("přístup k účtu nyní není povolen");
  expect(screen.getByRole("button", { name: "Ověřit stav" }).hasAttribute("disabled")).toBe(false);
  await advance(60_000);
  await settle();
  expect(progressRequests()).toHaveLength(13);
});

it("observes accepted pending progress beyond worker discovery and routes only on real admission", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  answers.push(Response.json({ state: "IN_PROGRESS", revision: 3 }));
  answers.push(Response.json({ state: "IN_PROGRESS", revision: 3 }));
  for (let read = 0; read < 19; read++) {
    answers.push(Response.json({ state: "IN_PROGRESS", revision: 3 }));
  }
  answers.push(Response.json({ state: "COMPLETE", revision: 12 }));
  answers.push(Response.json({ state: "ADMITTED" }));
  render(<EnrollmentProgress />);
  await advance(95_000);
  await settle();
  expect(progressRequests()).toHaveLength(21);
  await settle();
  expect(accountRequests()).toHaveLength(0);
  expect(router.replace).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Ověřuji…" }).hasAttribute("disabled")).toBe(true);
  await advance(5_000);
  await settle();
  expect(router.replace).toHaveBeenCalledExactlyOnceWith("/muj-ucet");
  expect(window.location.pathname).toBe("/muj-ucet");
  expect(progressRequests().map((request) => request.method)).toEqual([
    "GET",
    "POST",
    ...Array<string>(21).fill("GET"),
  ]);
});

it("bounds pending observation at 100 seconds and preserves manual read-only recovery", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  answer = () => Response.json({ state: "IN_PROGRESS", revision: 3 });
  render(<EnrollmentProgress />);
  await advance(99_999);
  await settle();
  expect(progressRequests()).toHaveLength(21);
  expect(screen.getByRole("button", { name: "Ověřuji…" }).hasAttribute("disabled")).toBe(true);
  await advance(1);
  await settle();
  expect(progressRequests()).toHaveLength(22);
  expect(progressRequests().filter((request) => request.method === "POST")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Obnovit registraci" }).hasAttribute("disabled")).toBe(
    false,
  );
  await settle();
  expect(accountRequests()).toHaveLength(0);
  expect(router.replace).not.toHaveBeenCalled();
  await advance(120_000);
  await settle();
  expect(progressRequests()).toHaveLength(22);
  fireEvent.click(screen.getByRole("button", { name: "Ověřit stav" }));
  await advance(120_000);
  await settle();
  expect(progressRequests()).toHaveLength(23);
  expect(progressRequests()[22]?.method).toBe("GET");
  expect(fetchProgress.mock.calls[22]?.[1]).toMatchObject({ method: "GET", cache: "no-store" });
  await settle();
  expect(accountRequests()).toHaveLength(0);
  expect(router.replace).not.toHaveBeenCalled();
});

it("keeps both pending and existing COMPLETE admission observation finite", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  for (let read = 0; read < 21; read++) {
    answers.push(Response.json({ state: "IN_PROGRESS" }));
  }
  answer = () => Response.json({ state: "COMPLETE" });
  render(<EnrollmentProgress />);
  await advance(109_999);
  await settle();
  expect(progressRequests()).toHaveLength(32);
  expect(screen.getByRole("status").textContent).toContain("Ověřuji přístup");
  await settle();
  expect(accountRequests()).toHaveLength(0);
  expect(router.replace).not.toHaveBeenCalled();
  await advance(60_001);
  await settle();
  expect(progressRequests()).toHaveLength(33);
  expect(progressRequests().filter((request) => request.method === "POST")).toHaveLength(1);
  expect(progressRequests().filter((request) => request.method === "GET")).toHaveLength(32);
  expect(screen.getByRole("status").textContent).toContain("přístup k účtu nyní není povolen");
  expect(screen.getByRole("button", { name: "Ověřit stav" }).hasAttribute("disabled")).toBe(false);
  await settle();
  expect(accountRequests()).toHaveLength(0);
  expect(router.replace).not.toHaveBeenCalled();
});

it.each([
  "FAILED",
  "TERMINATED",
  "RECONCILIATION_REQUIRED",
  "VERIFICATION_REQUIRED",
  "SESSION_CREATED",
  "UNKNOWN",
  undefined,
])("stops pending observation on %s without replay or admission", async (state) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  answers.push(Response.json({ state: "IN_PROGRESS" }));
  answers.push(Response.json({ state: "IN_PROGRESS" }));
  answers.push(Response.json({ state }));
  render(<EnrollmentProgress />);
  await advance(120_000);
  expect(progressRequests().map((request) => request.method)).toEqual(["GET", "POST", "GET"]);
  await settle();
  expect(accountRequests()).toHaveLength(0);
  expect(router.replace).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Ověřit stav" }).hasAttribute("disabled")).toBe(false);
  expect(screen.queryByRole("button", { name: "Obnovit registraci" }) !== null).toBe(
    state !== undefined && state !== "FAILED" && state !== "TERMINATED",
  );
});

it("does not observe or replay when the accepted resume still requires verification", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  answers.push(Response.json({ state: "VERIFICATION_REQUIRED" }));
  answers.push(Response.json({ state: "VERIFICATION_REQUIRED" }));
  render(<EnrollmentProgress />);
  await advance(120_000);
  expect(progressRequests().map((request) => request.method)).toEqual(["GET", "POST"]);
  expect(screen.getByRole("button", { name: "Obnovit registraci" }).hasAttribute("disabled")).toBe(
    false,
  );
  await settle();
  expect(accountRequests()).toHaveLength(0);
  expect(router.replace).not.toHaveBeenCalled();
});

it.each([401, 403, 429, 503])(
  "stops pending observation on an authoritative refusal or error (%s)",
  async (status) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    answers.push(Response.json({ state: "IN_PROGRESS" }));
    answers.push(Response.json({ state: "IN_PROGRESS" }));
    answers.push(Response.json({ message: "Přístup není dostupný." }, { status }));
    render(<EnrollmentProgress />);
    await advance(120_000);
    expect(progressRequests().map((request) => request.method)).toEqual(["GET", "POST", "GET"]);
    expect(screen.getByRole("alert").textContent).toContain("Přístup není dostupný.");
    expect(
      screen.getByRole("button", { name: "Obnovit registraci" }).hasAttribute("disabled"),
    ).toBe(false);
    await settle();
    expect(accountRequests()).toHaveLength(0);
    expect(router.replace).not.toHaveBeenCalled();
  },
);

it.each(["http", "transport"])(
  "does not observe or automatically retry an uncertain resume (%s)",
  async (failure) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    answers.push(Response.json({ state: "IN_PROGRESS" }));
    if (failure === "transport") {
      answers.push(disconnect);
    } else {
      answers.push(Response.json({ message: "Dočasně nedostupné." }, { status: 503 }));
    }
    render(<EnrollmentProgress />);
    await advance(120_000);
    expect(progressRequests().map((request) => request.method)).toEqual(["GET", "POST"]);
    expect(screen.getByRole("alert").textContent).toContain(
      failure === "transport" ? "fetch" : "Dočasně nedostupné.",
    );
    expect(
      screen.getByRole("button", { name: "Obnovit registraci" }).hasAttribute("disabled"),
    ).toBe(false);
    await settle();
    expect(accountRequests()).toHaveLength(0);
    expect(router.replace).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "does not restart pending observation after COMPLETE regresses during admission, delayed=%s",
  async (delayed) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    answers.push(Response.json({ state: "IN_PROGRESS" }));
    answers.push(Response.json({ state: "IN_PROGRESS" }));
    answers.push(Response.json({ state: "COMPLETE" }));
    if (delayed) {
      answers.push(Response.json({ state: "COMPLETE" }));
    }
    answers.push(Response.json({ state: "IN_PROGRESS" }));
    render(<EnrollmentProgress />);
    await advance(120_000);
    await settle();
    expect(progressRequests()).toHaveLength(delayed ? 5 : 4);
    expect(progressRequests().filter((request) => request.method === "POST")).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Obnovit registraci" }).hasAttribute("disabled"),
    ).toBe(false);
    await settle();
    expect(accountRequests()).toHaveLength(0);
    expect(router.replace).not.toHaveBeenCalled();
  },
);

it.each(["IN_PROGRESS", "VERIFICATION_REQUIRED"])(
  "keeps confirmed %s progress and allows explicit recovery after an uncertain automatic resume",
  async (state) => {
    answers.push(Response.json({ state, revision: 3 }));
    answers.push(Response.json({ message: "Dočasně nedostupné." }, { status: 503 }));
    answers.push(Response.json({ state: "COMPLETE", revision: 12 }));
    answers.push(Response.json({ state: "ADMITTED" }));
    render(<EnrollmentProgress />);
    expect((await screen.findByRole("alert")).textContent).toContain("Dočasně nedostupné.");
    await settle();
    expect(progressRequests()).toHaveLength(2);
    await settle();
    expect(accountRequests()).toHaveLength(0);
    expect(router.replace).not.toHaveBeenCalled();
    const resume = await screen.findByRole("button", { name: "Obnovit registraci" });
    await waitFor(() => expect(resume.hasAttribute("disabled")).toBe(false));
    fireEvent.click(resume);
    await waitFor(() => expect(window.location.pathname).toBe("/muj-ucet"));
    await settle();
    expect(router.replace).toHaveBeenCalledWith("/muj-ucet");
    expect(progressRequests().map((request) => request.method)).toEqual([
      "GET",
      "POST",
      "POST",
      "GET",
    ]);
  },
);

it("keeps confirmed completion when admission is unavailable and recovers with a read only", async () => {
  answers.push(Response.json({ state: "IN_PROGRESS", revision: 3 }));
  answers.push(Response.json({ state: "COMPLETE", revision: 12 }));
  answers.push(Response.json({ message: "Dočasně nedostupné." }, { status: 503 }));
  answers.push(Response.json({ state: "ADMITTED" }));
  render(<EnrollmentProgress />);
  await screen.findByRole("alert");
  expect(screen.getByRole("status").textContent).toContain("Registrace byla dokončena");
  expect(screen.queryByRole("button", { name: "Obnovit registraci" })).toBeNull();
  await settle();
  expect(accountRequests()).toHaveLength(0);
  expect(router.replace).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Ověřit stav" }));
  await waitFor(() => expect(window.location.pathname).toBe("/muj-ucet"));
  await settle();
  expect(router.replace).toHaveBeenCalledWith("/muj-ucet");
  expect(progressRequests().map((request) => request.method)).toEqual([
    "GET",
    "POST",
    "GET",
    "GET",
  ]);
});

it("waits for actual delayed admission after one resume, without displaying a premature denial", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  answers.push(Response.json({ state: "IN_PROGRESS" }));
  answers.push(Response.json({ state: "COMPLETE" }));
  answers.push(Response.json({ state: "COMPLETE" }));
  answers.push(Response.json({ state: "COMPLETE" }));
  answers.push(Response.json({ state: "ADMITTED" }));
  render(<EnrollmentProgress />);
  await advance(1_000);
  await settle();
  expect(progressRequests()).toHaveLength(4);
  await settle();
  expect(accountRequests()).toHaveLength(0);
  expect(router.replace).not.toHaveBeenCalled();
  expect(screen.getByRole("status").textContent).toContain("Ověřuji přístup");
  await advance(1_000);
  await settle();
  expect(router.replace).toHaveBeenCalledExactlyOnceWith("/muj-ucet");
  expect(window.location.pathname).toBe("/muj-ucet");
  expect(progressRequests().map((request) => request.method)).toEqual([
    "GET",
    "POST",
    "GET",
    "GET",
    "GET",
  ]);
});

it("rechecks actual admission when a reload initially reads COMPLETE", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  answers.push(Response.json({ state: "COMPLETE" }));
  answers.push(Response.json({ state: "ADMITTED" }));
  render(<EnrollmentProgress />);
  await advance(1_000);
  await settle();
  expect(router.replace).toHaveBeenCalledExactlyOnceWith("/muj-ucet");
  expect(window.location.pathname).toBe("/muj-ucet");
  expect(progressRequests().map((request) => request.method)).toEqual(["GET", "GET"]);
});

it.each([
  "FAILED",
  "TERMINATED",
  "RECONCILIATION_REQUIRED",
  "IN_PROGRESS",
  "VERIFICATION_REQUIRED",
])("stops read-only rechecks on %s without automatically mutating it", async (state) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  answers.push(Response.json({ state: "COMPLETE" }));
  answers.push(Response.json({ state }));
  render(<EnrollmentProgress />);
  await advance(60_000);
  await settle();
  expect(progressRequests()).toHaveLength(2);
  expect(progressRequests().map((request) => request.method)).toEqual(["GET", "GET"]);
  await settle();
  expect(accountRequests()).toHaveLength(0);
  expect(router.replace).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Ověřit stav" }).hasAttribute("disabled")).toBe(false);
});

it.each([401, 403, 429, 503])(
  "stops on an authoritative refusal or error (%s) during rechecks",
  async (status) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    answers.push(Response.json({ state: "COMPLETE" }));
    answers.push(Response.json({ message: "Přístup není dostupný." }, { status }));
    render(<EnrollmentProgress />);
    await advance(60_000);
    await settle();
    expect(progressRequests()).toHaveLength(2);
    await settle();
    expect(accountRequests()).toHaveLength(0);
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Přístup není dostupný.");
  },
);

it("uses the same read-only rechecks after an explicit reconciliation resume", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  answers.push(Response.json({ state: "RECONCILIATION_REQUIRED" }));
  answers.push(Response.json({ state: "COMPLETE" }));
  answers.push(Response.json({ state: "COMPLETE" }));
  answers.push(Response.json({ state: "ADMITTED" }));
  render(<EnrollmentProgress />);
  await advance(0);
  fireEvent.click(screen.getByRole("button", { name: "Obnovit registraci" }));
  await advance(1_000);
  await settle();
  expect(router.replace).toHaveBeenCalledExactlyOnceWith("/muj-ucet");
  expect(window.location.pathname).toBe("/muj-ucet");
  expect(progressRequests().map((request) => request.method)).toEqual([
    "GET",
    "POST",
    "GET",
    "GET",
  ]);
});

it("observes accepted pending progress after an explicit reconciliation resume", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  answers.push(Response.json({ state: "RECONCILIATION_REQUIRED" }));
  answers.push(Response.json({ state: "IN_PROGRESS" }));
  answers.push(Response.json({ state: "COMPLETE" }));
  answers.push(Response.json({ state: "COMPLETE" }));
  answers.push(Response.json({ state: "ADMITTED" }));
  render(<EnrollmentProgress />);
  await advance(0);
  fireEvent.click(screen.getByRole("button", { name: "Obnovit registraci" }));
  await advance(5_000);
  await settle();
  expect(progressRequests()).toHaveLength(4);
  expect(screen.getByRole("status").textContent).toContain("Ověřuji přístup");
  await settle();
  expect(accountRequests()).toHaveLength(0);
  expect(router.replace).not.toHaveBeenCalled();
  await advance(1_000);
  await settle();
  expect(router.replace).toHaveBeenCalledExactlyOnceWith("/muj-ucet");
  expect(window.location.pathname).toBe("/muj-ucet");
  expect(progressRequests().map((request) => request.method)).toEqual([
    "GET",
    "POST",
    "GET",
    "GET",
    "GET",
  ]);
});

it.each(["COMPLETE", "IN_PROGRESS"])(
  "cancels the %s waiting timer on unmount without issuing another read",
  async (state) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    answers.push(Response.json({ state }));
    if (state === "IN_PROGRESS") {
      answers.push(Response.json({ state }));
    }
    const view = render(<EnrollmentProgress />);
    await advance(0);
    const signal = fetchProgress.mock.calls[0]?.[1]?.signal;
    view.unmount();
    await advance(120_000);
    expect(signal?.aborted).toBe(true);
    await settle();
    expect(progressRequests()).toHaveLength(state === "IN_PROGRESS" ? 2 : 1);
    await settle();
    expect(accountRequests()).toHaveLength(0);
    expect(router.replace).not.toHaveBeenCalled();
  },
);

it.each(["COMPLETE", "IN_PROGRESS"])(
  "aborts an in-flight %s recheck and ignores late admission after unmount",
  async (state) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let resolveRead!: (response: Response) => void;
    answers.push(Response.json({ state }));
    if (state === "IN_PROGRESS") {
      answers.push(Response.json({ state }));
    }
    answers.push({
      response: new Promise<Response>((resolve) => {
        resolveRead = resolve;
      }),
    });
    const view = render(<EnrollmentProgress />);
    await advance(state === "IN_PROGRESS" ? 5_000 : 1_000);
    const requestCount = state === "IN_PROGRESS" ? 3 : 2;
    await settle();
    expect(progressRequests()).toHaveLength(requestCount);
    const requestIndex = network.requests.indexOf(progressRequests()[requestCount - 1]!);
    const signal = fetchProgress.mock.calls[requestCount - 1]?.[1]?.signal;
    view.unmount();
    await network.abortArrivals[requestIndex];
    await act(async () => {
      resolveRead(Response.json({ state: "ADMITTED" }));
    });
    await advance(120_000);
    expect(network.aborted.has(requestIndex)).toBe(true);
    expect(signal?.aborted).toBe(true);
    await settle();
    expect(progressRequests()).toHaveLength(requestCount);
    await settle();
    expect(accountRequests()).toHaveLength(0);
    expect(router.replace).not.toHaveBeenCalled();
  },
);

it("does not reread or route after an unmounted automatic resume resolves late", async () => {
  let resolveResume!: (response: Response) => void;
  answers.push(Response.json({ state: "IN_PROGRESS" }));
  answers.push({
    response: new Promise<Response>((resolve) => {
      resolveResume = resolve;
    }),
  });
  const view = render(<EnrollmentProgress />);
  await waitFor(() => expect(progressRequests()).toHaveLength(2));
  await settle();
  const requestIndex = network.requests.indexOf(progressRequests()[1]!);
  const signal = fetchProgress.mock.calls[1]?.[1]?.signal;
  view.unmount();
  await network.abortArrivals[requestIndex];
  await act(async () => {
    resolveResume(Response.json({ state: "COMPLETE" }));
  });
  await settle();
  expect(network.aborted.has(requestIndex)).toBe(true);
  expect(signal?.aborted).toBe(true);
  await settle();
  expect(progressRequests()).toHaveLength(2);
  await settle();
  expect(accountRequests()).toHaveLength(0);
  expect(router.replace).not.toHaveBeenCalled();
});
