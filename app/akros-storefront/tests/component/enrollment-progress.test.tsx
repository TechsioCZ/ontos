import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EnrollmentProgress } from "@/components/enrollment-progress";

const router = vi.hoisted(() => ({ replace: vi.fn<(path: string) => void>() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/components/store-link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
const fetchProgress = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.clearAllMocks();
  fetchProgress.mockReset();
  vi.stubGlobal("fetch", fetchProgress);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("recovers pending registration after a reload and resumes only on explicit request", async () => {
  fetchProgress.mockImplementation(async () =>
    Response.json({ state: "RECONCILIATION_REQUIRED", revision: 10 }),
  );
  const view = render(<EnrollmentProgress />);
  const resume = await screen.findByRole("button", { name: "Obnovit registraci" });
  expect(fetchProgress).toHaveBeenCalledOnce();
  expect(router.replace).not.toHaveBeenCalled();
  fireEvent.click(resume);
  await waitFor(() => expect(fetchProgress).toHaveBeenCalledTimes(2));
  expect(fetchProgress.mock.calls[1]![1]).toMatchObject({ method: "POST", body: "{}" });
  view.unmount();
  render(<EnrollmentProgress />);
  await screen.findByRole("button", { name: "Obnovit registraci" });
  expect(fetchProgress).toHaveBeenCalledTimes(3);
  expect(fetchProgress.mock.calls[2]![1]).toMatchObject({ method: "GET", cache: "no-store" });
});

it.each(["FAILED", "TERMINATED", "COMPLETE"])(
  "does not offer to replay a terminal native Attempt (%s)",
  async (state) => {
    vi.useFakeTimers();
    fetchProgress.mockImplementation(async () => Response.json({ state }));
    render(<EnrollmentProgress />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.getByRole("button", { name: "Ověřit stav" }).hasAttribute("disabled")).toBe(
      false,
    );
    expect(fetchProgress.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    expect(screen.queryByRole("button", { name: "Obnovit registraci" })).toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain(
      state === "COMPLETE" ? "přístup" : state === "FAILED" ? "nové přijetí" : "nelze ji obnovit",
    );
  },
);

it("opens the account only after real admission, not merely COMPLETE or SESSION_CREATED", async () => {
  fetchProgress.mockResolvedValue(Response.json({ state: "ADMITTED" }));
  render(<EnrollmentProgress />);
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/muj-ucet"));
});

it("shows owner authentication/outage refusals without automatic retry loops", async () => {
  fetchProgress.mockResolvedValue(
    Response.json({ message: "Přihlaste se ověřeným účtem." }, { status: 401 }),
  );
  render(<EnrollmentProgress />);
  expect((await screen.findByRole("alert")).textContent).toContain("Přihlaste se");
  expect(fetchProgress).toHaveBeenCalledOnce();
  expect(router.replace).not.toHaveBeenCalled();
});

it("starts a new enrollment only on explicit FAILED restart, never repeating signup or the old Attempt", async () => {
  fetchProgress.mockImplementation(async (_url, init) =>
    Response.json({ state: init?.method === "PUT" ? "IN_PROGRESS" : "FAILED", revision: 2 }),
  );
  render(<EnrollmentProgress />);
  const restart = await screen.findByRole("button", { name: "Zahájit nové přijetí účtu" });
  expect(fetchProgress).toHaveBeenCalledOnce();
  fireEvent.click(restart);
  await screen.findByRole("button", { name: "Obnovit registraci" });
  expect(fetchProgress.mock.calls[1]![1]).toMatchObject({ method: "PUT", body: "{}" });
  expect(screen.queryByRole("button", { name: "Zahájit nové přijetí účtu" })).toBeNull();
  expect(router.replace).not.toHaveBeenCalled();
});

it.each(["IN_PROGRESS", "VERIFICATION_REQUIRED"])(
  "automatically resumes %s once after login and checks real account admission before routing",
  async (state) => {
    fetchProgress
      .mockResolvedValueOnce(Response.json({ state, revision: 3 }))
      .mockResolvedValueOnce(Response.json({ state: "COMPLETE", revision: 12 }))
      .mockResolvedValueOnce(Response.json({ state: "ADMITTED" }));
    render(<EnrollmentProgress />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/muj-ucet"));
    expect(fetchProgress).toHaveBeenCalledTimes(3);
    expect(fetchProgress.mock.calls.map(([, init]) => init?.method)).toEqual([
      "GET",
      "POST",
      "GET",
    ]);
    expect(fetchProgress.mock.calls[1]![1]).toMatchObject({ body: "{}", cache: "no-store" });
  },
);

it("bounds read-only rechecks without treating persistent COMPLETE as admission or replaying resume", async () => {
  vi.useFakeTimers();
  fetchProgress
    .mockImplementation(async () => Response.json({ state: "COMPLETE", revision: 12 }))
    .mockResolvedValueOnce(Response.json({ state: "IN_PROGRESS", revision: 3 }))
    .mockResolvedValueOnce(Response.json({ state: "COMPLETE", revision: 12 }));
  render(<EnrollmentProgress />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(fetchProgress).toHaveBeenCalledTimes(13);
  expect(fetchProgress.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  expect(router.replace).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Obnovit registraci" })).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("přístup k účtu nyní není povolen");
  expect(screen.getByRole("button", { name: "Ověřit stav" }).hasAttribute("disabled")).toBe(false);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(fetchProgress).toHaveBeenCalledTimes(13);
});

it("observes accepted pending progress beyond worker discovery and routes only on real admission", async () => {
  vi.useFakeTimers();
  fetchProgress
    .mockResolvedValueOnce(Response.json({ state: "IN_PROGRESS", revision: 3 }))
    .mockResolvedValueOnce(Response.json({ state: "IN_PROGRESS", revision: 3 }));
  for (let read = 0; read < 19; read++) {
    fetchProgress.mockResolvedValueOnce(Response.json({ state: "IN_PROGRESS", revision: 3 }));
  }
  fetchProgress
    .mockResolvedValueOnce(Response.json({ state: "COMPLETE", revision: 12 }))
    .mockResolvedValueOnce(Response.json({ state: "ADMITTED" }));
  render(<EnrollmentProgress />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(95_000);
  });
  expect(fetchProgress).toHaveBeenCalledTimes(21);
  expect(router.replace).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Ověřuji…" }).hasAttribute("disabled")).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(router.replace).toHaveBeenCalledExactlyOnceWith("/muj-ucet");
  expect(fetchProgress.mock.calls.map(([, init]) => init?.method)).toEqual([
    "GET",
    "POST",
    ...Array<string>(21).fill("GET"),
  ]);
});

it("bounds pending observation at 100 seconds and preserves manual read-only recovery", async () => {
  vi.useFakeTimers();
  fetchProgress.mockImplementation(async () =>
    Response.json({ state: "IN_PROGRESS", revision: 3 }),
  );
  render(<EnrollmentProgress />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(99_999);
  });
  expect(fetchProgress).toHaveBeenCalledTimes(21);
  expect(screen.getByRole("button", { name: "Ověřuji…" }).hasAttribute("disabled")).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(fetchProgress).toHaveBeenCalledTimes(22);
  expect(fetchProgress.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Obnovit registraci" }).hasAttribute("disabled")).toBe(
    false,
  );
  expect(router.replace).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000);
  });
  expect(fetchProgress).toHaveBeenCalledTimes(22);
  fireEvent.click(screen.getByRole("button", { name: "Ověřit stav" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000);
  });
  expect(fetchProgress).toHaveBeenCalledTimes(23);
  expect(fetchProgress.mock.calls[22]![1]).toMatchObject({ method: "GET", cache: "no-store" });
  expect(router.replace).not.toHaveBeenCalled();
});

it("keeps both pending and existing COMPLETE admission observation finite", async () => {
  vi.useFakeTimers();
  for (let read = 0; read < 21; read++) {
    fetchProgress.mockResolvedValueOnce(Response.json({ state: "IN_PROGRESS" }));
  }
  fetchProgress.mockImplementation(async () => Response.json({ state: "COMPLETE" }));
  render(<EnrollmentProgress />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(109_999);
  });
  expect(fetchProgress).toHaveBeenCalledTimes(32);
  expect(screen.getByRole("status").textContent).toContain("Ověřuji přístup");
  expect(router.replace).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_001);
  });
  expect(fetchProgress).toHaveBeenCalledTimes(33);
  expect(fetchProgress.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  expect(fetchProgress.mock.calls.filter(([, init]) => init?.method === "GET")).toHaveLength(32);
  expect(screen.getByRole("status").textContent).toContain("přístup k účtu nyní není povolen");
  expect(screen.getByRole("button", { name: "Ověřit stav" }).hasAttribute("disabled")).toBe(false);
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
  vi.useFakeTimers();
  fetchProgress
    .mockResolvedValueOnce(Response.json({ state: "IN_PROGRESS" }))
    .mockResolvedValueOnce(Response.json({ state: "IN_PROGRESS" }))
    .mockResolvedValueOnce(Response.json({ state }));
  render(<EnrollmentProgress />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000);
  });
  expect(fetchProgress.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "POST", "GET"]);
  expect(router.replace).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Ověřit stav" }).hasAttribute("disabled")).toBe(false);
  expect(screen.queryByRole("button", { name: "Obnovit registraci" }) !== null).toBe(
    state !== undefined && state !== "FAILED" && state !== "TERMINATED",
  );
});

it("does not observe or replay when the accepted resume still requires verification", async () => {
  vi.useFakeTimers();
  fetchProgress
    .mockResolvedValueOnce(Response.json({ state: "VERIFICATION_REQUIRED" }))
    .mockResolvedValueOnce(Response.json({ state: "VERIFICATION_REQUIRED" }));
  render(<EnrollmentProgress />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000);
  });
  expect(fetchProgress.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "POST"]);
  expect(screen.getByRole("button", { name: "Obnovit registraci" }).hasAttribute("disabled")).toBe(
    false,
  );
  expect(router.replace).not.toHaveBeenCalled();
});

it.each([401, 403, 429, 503])(
  "stops pending observation on an authoritative refusal or error (%s)",
  async (status) => {
    vi.useFakeTimers();
    fetchProgress
      .mockResolvedValueOnce(Response.json({ state: "IN_PROGRESS" }))
      .mockResolvedValueOnce(Response.json({ state: "IN_PROGRESS" }))
      .mockResolvedValueOnce(Response.json({ message: "Přístup není dostupný." }, { status }));
    render(<EnrollmentProgress />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(fetchProgress.mock.calls.map(([, init]) => init?.method)).toEqual([
      "GET",
      "POST",
      "GET",
    ]);
    expect(screen.getByRole("alert").textContent).toContain("Přístup není dostupný.");
    expect(
      screen.getByRole("button", { name: "Obnovit registraci" }).hasAttribute("disabled"),
    ).toBe(false);
    expect(router.replace).not.toHaveBeenCalled();
  },
);

it.each(["http", "transport"])(
  "does not observe or automatically retry an uncertain resume (%s)",
  async (failure) => {
    vi.useFakeTimers();
    fetchProgress.mockResolvedValueOnce(Response.json({ state: "IN_PROGRESS" }));
    if (failure === "transport") {
      fetchProgress.mockRejectedValueOnce(new TypeError("Dočasně nedostupné."));
    } else {
      fetchProgress.mockResolvedValueOnce(
        Response.json({ message: "Dočasně nedostupné." }, { status: 503 }),
      );
    }
    render(<EnrollmentProgress />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(fetchProgress.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "POST"]);
    expect(screen.getByRole("alert").textContent).toContain("Dočasně nedostupné.");
    expect(
      screen.getByRole("button", { name: "Obnovit registraci" }).hasAttribute("disabled"),
    ).toBe(false);
    expect(router.replace).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "does not restart pending observation after COMPLETE regresses during admission, delayed=%s",
  async (delayed) => {
    vi.useFakeTimers();
    fetchProgress
      .mockResolvedValueOnce(Response.json({ state: "IN_PROGRESS" }))
      .mockResolvedValueOnce(Response.json({ state: "IN_PROGRESS" }))
      .mockResolvedValueOnce(Response.json({ state: "COMPLETE" }));
    if (delayed) {
      fetchProgress.mockResolvedValueOnce(Response.json({ state: "COMPLETE" }));
    }
    fetchProgress.mockResolvedValueOnce(Response.json({ state: "IN_PROGRESS" }));
    render(<EnrollmentProgress />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(fetchProgress).toHaveBeenCalledTimes(delayed ? 5 : 4);
    expect(fetchProgress.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Obnovit registraci" }).hasAttribute("disabled"),
    ).toBe(false);
    expect(router.replace).not.toHaveBeenCalled();
  },
);

it.each(["IN_PROGRESS", "VERIFICATION_REQUIRED"])(
  "keeps confirmed %s progress and allows explicit recovery after an uncertain automatic resume",
  async (state) => {
    fetchProgress
      .mockResolvedValueOnce(Response.json({ state, revision: 3 }))
      .mockResolvedValueOnce(Response.json({ message: "Dočasně nedostupné." }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ state: "COMPLETE", revision: 12 }))
      .mockResolvedValueOnce(Response.json({ state: "ADMITTED" }));
    render(<EnrollmentProgress />);
    expect((await screen.findByRole("alert")).textContent).toContain("Dočasně nedostupné.");
    expect(fetchProgress).toHaveBeenCalledTimes(2);
    expect(router.replace).not.toHaveBeenCalled();
    const resume = await screen.findByRole("button", { name: "Obnovit registraci" });
    await waitFor(() => expect(resume.hasAttribute("disabled")).toBe(false));
    fireEvent.click(resume);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/muj-ucet"));
    expect(fetchProgress.mock.calls.map(([, init]) => init?.method)).toEqual([
      "GET",
      "POST",
      "POST",
      "GET",
    ]);
  },
);

it("keeps confirmed completion when admission is unavailable and recovers with a read only", async () => {
  fetchProgress
    .mockResolvedValueOnce(Response.json({ state: "IN_PROGRESS", revision: 3 }))
    .mockResolvedValueOnce(Response.json({ state: "COMPLETE", revision: 12 }))
    .mockResolvedValueOnce(Response.json({ message: "Dočasně nedostupné." }, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ state: "ADMITTED" }));
  render(<EnrollmentProgress />);
  await screen.findByRole("alert");
  expect(screen.getByRole("status").textContent).toContain("Registrace byla dokončena");
  expect(screen.queryByRole("button", { name: "Obnovit registraci" })).toBeNull();
  expect(router.replace).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Ověřit stav" }));
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/muj-ucet"));
  expect(fetchProgress.mock.calls.map(([, init]) => init?.method)).toEqual([
    "GET",
    "POST",
    "GET",
    "GET",
  ]);
});

it("waits for actual delayed admission after one resume, without displaying a premature denial", async () => {
  vi.useFakeTimers();
  fetchProgress
    .mockResolvedValueOnce(Response.json({ state: "IN_PROGRESS" }))
    .mockResolvedValueOnce(Response.json({ state: "COMPLETE" }))
    .mockResolvedValueOnce(Response.json({ state: "COMPLETE" }))
    .mockResolvedValueOnce(Response.json({ state: "COMPLETE" }))
    .mockResolvedValueOnce(Response.json({ state: "ADMITTED" }));
  render(<EnrollmentProgress />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(fetchProgress).toHaveBeenCalledTimes(4);
  expect(router.replace).not.toHaveBeenCalled();
  expect(screen.getByRole("status").textContent).toContain("Ověřuji přístup");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(router.replace).toHaveBeenCalledExactlyOnceWith("/muj-ucet");
  expect(fetchProgress.mock.calls.map(([, init]) => init?.method)).toEqual([
    "GET",
    "POST",
    "GET",
    "GET",
    "GET",
  ]);
});

it("rechecks actual admission when a reload initially reads COMPLETE", async () => {
  vi.useFakeTimers();
  fetchProgress
    .mockResolvedValueOnce(Response.json({ state: "COMPLETE" }))
    .mockResolvedValueOnce(Response.json({ state: "ADMITTED" }));
  render(<EnrollmentProgress />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(router.replace).toHaveBeenCalledExactlyOnceWith("/muj-ucet");
  expect(fetchProgress.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "GET"]);
});

it.each([
  "FAILED",
  "TERMINATED",
  "RECONCILIATION_REQUIRED",
  "IN_PROGRESS",
  "VERIFICATION_REQUIRED",
])("stops read-only rechecks on %s without automatically mutating it", async (state) => {
  vi.useFakeTimers();
  fetchProgress
    .mockResolvedValueOnce(Response.json({ state: "COMPLETE" }))
    .mockResolvedValueOnce(Response.json({ state }));
  render(<EnrollmentProgress />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(fetchProgress).toHaveBeenCalledTimes(2);
  expect(fetchProgress.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "GET"]);
  expect(router.replace).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Ověřit stav" }).hasAttribute("disabled")).toBe(false);
});

it.each([401, 403, 429, 503])(
  "stops on an authoritative refusal or error (%s) during rechecks",
  async (status) => {
    vi.useFakeTimers();
    fetchProgress
      .mockResolvedValueOnce(Response.json({ state: "COMPLETE" }))
      .mockResolvedValueOnce(Response.json({ message: "Přístup není dostupný." }, { status }));
    render(<EnrollmentProgress />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchProgress).toHaveBeenCalledTimes(2);
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Přístup není dostupný.");
  },
);

it("uses the same read-only rechecks after an explicit reconciliation resume", async () => {
  vi.useFakeTimers();
  fetchProgress
    .mockResolvedValueOnce(Response.json({ state: "RECONCILIATION_REQUIRED" }))
    .mockResolvedValueOnce(Response.json({ state: "COMPLETE" }))
    .mockResolvedValueOnce(Response.json({ state: "COMPLETE" }))
    .mockResolvedValueOnce(Response.json({ state: "ADMITTED" }));
  render(<EnrollmentProgress />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole("button", { name: "Obnovit registraci" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(router.replace).toHaveBeenCalledExactlyOnceWith("/muj-ucet");
  expect(fetchProgress.mock.calls.map(([, init]) => init?.method)).toEqual([
    "GET",
    "POST",
    "GET",
    "GET",
  ]);
});

it("observes accepted pending progress after an explicit reconciliation resume", async () => {
  vi.useFakeTimers();
  fetchProgress
    .mockResolvedValueOnce(Response.json({ state: "RECONCILIATION_REQUIRED" }))
    .mockResolvedValueOnce(Response.json({ state: "IN_PROGRESS" }))
    .mockResolvedValueOnce(Response.json({ state: "COMPLETE" }))
    .mockResolvedValueOnce(Response.json({ state: "COMPLETE" }))
    .mockResolvedValueOnce(Response.json({ state: "ADMITTED" }));
  render(<EnrollmentProgress />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole("button", { name: "Obnovit registraci" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(fetchProgress).toHaveBeenCalledTimes(4);
  expect(screen.getByRole("status").textContent).toContain("Ověřuji přístup");
  expect(router.replace).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(router.replace).toHaveBeenCalledExactlyOnceWith("/muj-ucet");
  expect(fetchProgress.mock.calls.map(([, init]) => init?.method)).toEqual([
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
    vi.useFakeTimers();
    fetchProgress.mockResolvedValueOnce(Response.json({ state }));
    if (state === "IN_PROGRESS") {
      fetchProgress.mockResolvedValueOnce(Response.json({ state }));
    }
    const view = render(<EnrollmentProgress />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const signal = fetchProgress.mock.calls[0]![1]!.signal!;
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(signal.aborted).toBe(true);
    expect(fetchProgress).toHaveBeenCalledTimes(state === "IN_PROGRESS" ? 2 : 1);
    expect(router.replace).not.toHaveBeenCalled();
  },
);

it.each(["COMPLETE", "IN_PROGRESS"])(
  "aborts an in-flight %s recheck and ignores late admission after unmount",
  async (state) => {
    vi.useFakeTimers();
    let resolveRead!: (response: Response) => void;
    fetchProgress.mockResolvedValueOnce(Response.json({ state }));
    if (state === "IN_PROGRESS") {
      fetchProgress.mockResolvedValueOnce(Response.json({ state }));
    }
    fetchProgress.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    const view = render(<EnrollmentProgress />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(state === "IN_PROGRESS" ? 5_000 : 1_000);
    });
    const requestCount = state === "IN_PROGRESS" ? 3 : 2;
    expect(fetchProgress).toHaveBeenCalledTimes(requestCount);
    const signal = fetchProgress.mock.calls[requestCount - 1]![1]!.signal!;
    view.unmount();
    await act(async () => {
      resolveRead(Response.json({ state: "ADMITTED" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(signal.aborted).toBe(true);
    expect(fetchProgress).toHaveBeenCalledTimes(requestCount);
    expect(router.replace).not.toHaveBeenCalled();
  },
);

it("does not reread or route after an unmounted automatic resume resolves late", async () => {
  let resolveResume!: (response: Response) => void;
  fetchProgress
    .mockResolvedValueOnce(Response.json({ state: "IN_PROGRESS" }))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveResume = resolve;
        }),
    );
  const view = render(<EnrollmentProgress />);
  await waitFor(() => expect(fetchProgress).toHaveBeenCalledTimes(2));
  const signal = fetchProgress.mock.calls[1]![1]!.signal!;
  view.unmount();
  await act(async () => {
    resolveResume(Response.json({ state: "COMPLETE" }));
  });
  expect(signal.aborted).toBe(true);
  expect(fetchProgress).toHaveBeenCalledTimes(2);
  expect(router.replace).not.toHaveBeenCalled();
});
