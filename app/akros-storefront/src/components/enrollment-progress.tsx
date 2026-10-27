"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@techsio/ui-kit/atoms/button";
import StoreLink from "@/components/store-link";

const isError = (value: unknown): value is Error =>
  value !== null && value !== undefined && Error.prototype.isPrototypeOf(value);

type Progress = { state?: string; message?: string };
const terminal = (state?: string) =>
  state === "FAILED" || state === "TERMINATED" || state === "COMPLETE";

async function loadProgress(
  operation: "read" | "resume" | "restart",
  signal?: AbortSignal,
): Promise<Progress> {
  const response = await fetch("/api/ontos/enrollment", {
    method: operation === "restart" ? "PUT" : operation === "resume" ? "POST" : "GET",
    cache: "no-store",
    signal,
    ...(operation !== "read"
      ? { headers: { "content-type": "application/json" }, body: "{}" }
      : {}),
  });
  const result = (await response.json()) as Progress;
  if (!response.ok) throw new Error(result.message ?? "Stav registrace je dočasně nedostupný.");
  return result;
}

const admissionRechecks = 10;
const admissionRecheckDelay = 1_000;
const pendingRechecks = 20;
const pendingRecheckDelay = 5_000;

function waitForProgressRecheck(signal: AbortSignal, delay: number): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function EnrollmentProgress() {
  const router = useRouter();
  const [progress, setProgress] = useState<Progress>({});
  const [pending, setPending] = useState(true);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);

  const checkProgress = useCallback(
    (operation: "read" | "resume" | "restart", afterLogin = false) => {
      if (request.current) return;
      const controller = new AbortController();
      request.current = controller;
      const { signal } = controller;
      return loadProgress(operation, signal)
        .then(async (initial) => {
          let result = initial;
          signal.throwIfAborted();
          // Keep confirmed progress and its recovery controls if the following request fails.
          setProgress(result);
          let resumed = false;
          // Login may resume once. Reconciliation and terminal Attempts never replay automatically.
          if (
            afterLogin &&
            (result.state === "IN_PROGRESS" || result.state === "VERIFICATION_REQUIRED")
          ) {
            result = await loadProgress("resume", signal);
            signal.throwIfAborted();
            setProgress(result);
            resumed = true;
          }
          // An accepted resume may leave the hosted worker in charge. Observe, never replay.
          // Enter this phase only here, not after a later COMPLETE regresses to IN_PROGRESS.
          for (
            let attempt = 0;
            (operation === "resume" || resumed) &&
            result.state === "IN_PROGRESS" &&
            attempt < pendingRechecks;
            attempt++
          ) {
            await waitForProgressRecheck(signal, pendingRecheckDelay);
            result = await loadProgress("read", signal);
            signal.throwIfAborted();
            setProgress(result);
          }
          if ((operation !== "read" || resumed) && result.state === "COMPLETE") {
            result = await loadProgress("read", signal);
            signal.throwIfAborted();
          }
          setProgress(result);
          // COMPLETE does not distinguish pending admission from denial. Only bounded real GETs
          // can establish ADMITTED; an error or any other owner state stops these read-only checks.
          for (
            let attempt = 0;
            result.state === "COMPLETE" && attempt < admissionRechecks;
            attempt++
          ) {
            await waitForProgressRecheck(signal, admissionRecheckDelay);
            result = await loadProgress("read", signal);
            signal.throwIfAborted();
            setProgress(result);
          }
          if (result.state === "ADMITTED") router.replace("/muj-ucet");
        })
        .catch((cause: unknown) => {
          if (!signal.aborted) {
            setError(isError(cause) ? cause.message : "Stav registrace je nedostupný.");
          }
        })
        .finally(() => {
          if (request.current === controller) {
            request.current = null;
            if (!signal.aborted) setPending(false);
          }
        });
    },
    [router],
  );

  useEffect(() => {
    void checkProgress("read", true);
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [checkProgress]);

  function refresh(operation: "read" | "resume" | "restart") {
    if (request.current) return;
    setPending(true);
    setError("");
    void checkProgress(operation);
  }

  return (
    <div className="akros-auth-form">
      <output>
        {progress.state === "FAILED"
          ? "Původní registrace byla zamítnuta. Můžete zahájit nové přijetí se stejným ověřeným účtem; již potvrzené údaje se zachovají a původní zamítnutý krok se neopakuje."
          : progress.state === "TERMINATED"
            ? "Registrace byla ukončena a nelze ji obnovit. Kontaktujte podporu pro nové přijetí účtu; původní zamítnutý krok se neopakuje."
            : progress.state === "COMPLETE"
              ? pending
                ? "Registrace byla dokončena. Ověřuji přístup k účtu."
                : "Registrace byla dokončena, ale přístup k účtu nyní není povolen. Obnovení registrace neopravňuje přístup."
              : progress.state === "ADMITTED"
                ? "Účet je připraven."
                : "Přihlášení samo o sobě nedokončuje registraci. Zde ověříte přijetí účtu a obnovíte rozpracované kroky."}
      </output>
      {error && <p role="alert">{error}</p>}
      <Button
        disabled={pending}
        onClick={() => {
          void refresh("read");
        }}
        variant="primary"
      >
        {pending ? "Ověřuji…" : "Ověřit stav"}
      </Button>
      {!terminal(progress.state) && progress.state && progress.state !== "ADMITTED" && (
        <Button
          disabled={pending}
          onClick={() => {
            void refresh("resume");
          }}
          variant="secondary"
        >
          Obnovit registraci
        </Button>
      )}
      {progress.state === "FAILED" && (
        <Button
          disabled={pending}
          onClick={() => {
            void refresh("restart");
          }}
          variant="secondary"
        >
          Zahájit nové přijetí účtu
        </Button>
      )}
      <StoreLink href="/prihlaseni">Přihlásit se ověřeným účtem</StoreLink>
    </div>
  );
}
