"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@techsio/ui-kit/atoms/button";
import StoreLink from "@/components/store-link";

type Progress = { state?: string; message?: string };
const terminal = (state?: string) =>
  state === "FAILED" || state === "TERMINATED" || state === "COMPLETE";

async function loadProgress(resume: boolean, signal?: AbortSignal): Promise<Progress> {
  const response = await fetch("/api/ontos/enrollment", {
    method: resume ? "POST" : "GET",
    cache: "no-store",
    signal,
    ...(resume ? { headers: { "content-type": "application/json" }, body: "{}" } : {}),
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
    loadProgress(false, controller.signal)
      .then((result) => {
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

  async function refresh(resume: boolean) {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      const result = await loadProgress(resume);
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
        {progress.state === "FAILED" || progress.state === "TERMINATED"
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
          void refresh(false);
        }}
        variant="primary"
      >
        {pending ? "Ověřuji…" : "Ověřit stav"}
      </Button>
      {!terminal(progress.state) && progress.state && progress.state !== "ADMITTED" && (
        <Button
          disabled={pending}
          onClick={() => {
            void refresh(true);
          }}
          variant="secondary"
        >
          Obnovit registraci
        </Button>
      )}
      <StoreLink href="/prihlaseni">Přihlásit se ověřeným účtem</StoreLink>
    </div>
  );
}
