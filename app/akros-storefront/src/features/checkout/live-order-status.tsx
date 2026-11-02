"use client";
import { useEffect, useState } from "react";
import { useDictionary, useMoney } from "@/ontos/market-context";

/** Polling interval of the live OntOS order status on the confirmation page. */
const LIVE_ORDER_STATUS_POLL_MS = 10_000;

type State =
  | { kind: "loading" }
  | { kind: "ready"; status?: string; statusLabel: string; updatedAt: string }
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
  const { checkout, account } = useDictionary();
  const copy = checkout.liveStatus;
  const { locale } = useMoney();
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    // One request at a time; a focus during an in-flight read or after a final status is a no-op.
    let busy = false;
    let final = false;
    const load = async () => {
      if (busy || final) return;
      busy = true;
      window.clearTimeout(timer);
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
            status?: unknown;
            statusLabel?: unknown;
            updatedAt?: unknown;
            final?: unknown;
          };
          if (stopped) return;
          if (
            typeof body.statusLabel !== "string" ||
            typeof body.updatedAt !== "string" ||
            !Number.isFinite(Date.parse(body.updatedAt))
          )
            setState({ kind: "error" });
          else {
            setState({
              kind: "ready",
              ...(typeof body.status === "string" ? { status: body.status } : {}),
              statusLabel: body.statusLabel,
              updatedAt: body.updatedAt,
            });
            final = body.final === true;
          }
        }
      } catch {
        if (!stopped) setState({ kind: "error" });
      }
      busy = false;
      if (!stopped && !final) timer = window.setTimeout(load, LIVE_ORDER_STATUS_POLL_MS);
    };
    const onFocus = () => {
      void load();
    };
    void load();
    window.addEventListener("focus", onFocus);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [orderId, clientRequestId]);

  return (
    <output aria-live="polite" className="block text-sm" data-sf-live-order-status="">
      {state.kind === "loading" && copy.loading}
      {state.kind === "missing" && copy.missing}
      {state.kind === "error" && copy.error}
      {state.kind === "ready" && (
        <>
          {copy.current}{" "}
          <strong>
            {(state.status !== undefined &&
              (account.orderStatus as Readonly<Record<string, string>>)[state.status]) ||
              state.statusLabel}
          </strong>
          <span className="block text-xs text-(--color-fg-secondary)">
            {copy.updated} {/* Same format as the e-mail receipts below: "21. 10. 2026 3:08". */}
            {new Intl.DateTimeFormat(locale, {
              dateStyle: "medium",
              timeStyle: "short",
              timeZone: "Europe/Prague",
            }).format(new Date(state.updatedAt))}
          </span>
        </>
      )}
    </output>
  );
}
