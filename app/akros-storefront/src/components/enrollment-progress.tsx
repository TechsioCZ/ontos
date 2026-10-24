"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@techsio/ui-kit/atoms/button";
import StoreLink from "@/components/store-link";

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

export function EnrollmentProgress() {
  const router = useRouter();
  const [progress, setProgress] = useState<Progress>({});
  const [pending, setPending] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    loadProgress("read", controller.signal)
      .then(async (initial) => {
        if (controller.signal.aborted) return;
        // Login lands here. One explicit, request-owned pass completes a pending registration;
        // terminal/reconciliation states never replay automatically and there is no polling loop.
        let result = initial;
        if (result.state === "IN_PROGRESS" || result.state === "VERIFICATION_REQUIRED") {
          result = await loadProgress("resume");
          if (controller.signal.aborted) return;
          // COMPLETE is owner evidence, not account admission. Recheck the real account before routing.
          if (result.state === "COMPLETE") result = await loadProgress("read", controller.signal);
        }
        if (controller.signal.aborted) return;
        setProgress(result);
        setPending(false);
        if (result.state === "ADMITTED") router.replace("/muj-ucet");
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "Stav registrace je nedostupný.");
        setPending(false);
      });
    return () => controller.abort();
  }, [router]);

  async function refresh(operation: "read" | "resume" | "restart") {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      let result = await loadProgress(operation);
      if (operation !== "read" && result.state === "COMPLETE") result = await loadProgress("read");
      setProgress(result);
      if (result.state === "ADMITTED") router.replace("/muj-ucet");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Stav registrace je nedostupný.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="akros-auth-form">
      <output>
        {progress.state === "FAILED"
          ? "Původní registrace byla zamítnuta. Můžete zahájit nové přijetí se stejným ověřeným účtem; již potvrzené údaje se zachovají a původní zamítnutý krok se neopakuje."
          : progress.state === "TERMINATED"
            ? "Registrace byla ukončena a nelze ji obnovit. Kontaktujte podporu pro nové přijetí účtu; původní zamítnutý krok se neopakuje."
            : progress.state === "COMPLETE"
              ? "Registrace byla dokončena, ale přístup k účtu nyní není povolen. Obnovení registrace neopravňuje přístup."
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
