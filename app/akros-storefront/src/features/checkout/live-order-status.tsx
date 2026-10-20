"use client";
import { useEffect, useState } from "react";

/** Polling interval of the live OntOS order status on the confirmation page. */
export const LIVE_ORDER_STATUS_POLL_MS = 10_000;

type State =
  | { kind: "loading" }
  | { kind: "ready"; statusLabel: string; updatedAt: string }
  | { kind: "missing" }
  | { kind: "error" };

export function LiveOrderStatus({
  orderId,
  clientRequestId,
}: {
  orderId: string;
  clientRequestId: string;
}) {
  const [state, setState] = useState<State>({ kind: "loading" });
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const load = async () => {
      window.clearTimeout(timer);
      let final = false;
      try {
        const response = await fetch("/api/ontos/order-status", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ orderId, clientRequestId }),
          cache: "no-store",
        });
        if (stopped) return;
        if (response.status === 404) setState({ kind: "missing" });
        else if (!response.ok) setState({ kind: "error" });
        else {
          const body = (await response.json()) as {
            statusLabel?: unknown;
            updatedAt?: unknown;
            final?: unknown;
          };
          if (stopped) return;
          if (typeof body.statusLabel !== "string" || typeof body.updatedAt !== "string")
            setState({ kind: "error" });
          else {
            setState({ kind: "ready", statusLabel: body.statusLabel, updatedAt: body.updatedAt });
            final = body.final === true;
          }
        }
      } catch {
        if (!stopped) setState({ kind: "error" });
      }
      if (!stopped && !final) timer = window.setTimeout(load, LIVE_ORDER_STATUS_POLL_MS);
    };
    const onFocus = () => void load();
    void load();
    window.addEventListener("focus", onFocus);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [orderId, clientRequestId]);

  return (
    <output aria-live="polite" className="block text-sm" data-akros-live-order-status="">
      {state.kind === "loading" && "Načítám aktuální stav objednávky…"}
      {state.kind === "missing" && "Stav objednávky zatím není k dispozici."}
      {state.kind === "error" && "Aktuální stav objednávky se nepodařilo načíst. Zkusíme to znovu."}
      {state.kind === "ready" && (
        <>
          Aktuální stav v OntOS: <strong>{state.statusLabel}</strong>
          <span className="block text-xs text-(--color-fg-secondary)">
            Aktualizováno{" "}
            {new Date(state.updatedAt).toLocaleString("cs-CZ", {
              dateStyle: "short",
              timeStyle: "short",
            })}
          </span>
        </>
      )}
    </output>
  );
}
