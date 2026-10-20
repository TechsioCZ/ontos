"use client";
import { useEffect, useState } from "react";

type Receipt = { event: string; status: string; sentAt: string | null };
type State = { kind: "loading" } | { kind: "unavailable" } | { kind: "ready"; deliveries: Receipt[] };
const eventLabels: Record<string, string> = { ORDER_CREATED: "Potvrzení přijetí objednávky", CONFIRMED: "Objednávka potvrzena", SHIPPED: "Předáno dopravci", DELIVERED: "Objednávka dokončena", CANCELLED: "Objednávka stornována" };
const statusLabels: Record<string, string> = { SENT: "Odesláno e-mailem", SENDING: "Odesílá se…", RETRY: "Čeká na odeslání – e-mailový server je dočasně nedostupný", FAILED: "Odeslání selhalo", UNKNOWN: "Odeslání nelze potvrdit" };
const formatTime = (iso: string) => new Intl.DateTimeFormat("cs-CZ", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Prague" }).format(new Date(iso));

export function OrderEmailStatus({ email, orderNumber }: { email: string; orderNumber: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  useEffect(() => {
    let cancelled = false;
    let polls = 0;
    const load = async () => {
      try {
        const response = await fetch(`/api/ontos/order-emails?orderNumber=${encodeURIComponent(orderNumber)}`, { cache: "no-store" });
        if (!response.ok) throw new Error(String(response.status));
        const body = (await response.json()) as { deliveries: Receipt[] };
        if (!cancelled) setState({ kind: "ready", deliveries: body.deliveries });
      } catch {
        if (!cancelled) setState({ kind: "unavailable" });
      }
    };
    void load();
    const timer = window.setInterval(() => {
      polls += 1;
      if (polls > 60) { window.clearInterval(timer); return; }
      void load();
    }, 4000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [orderNumber]);
  return (
    <section aria-labelledby="order-emails-title" className="grid gap-2 rounded-sm border border-(--color-border-primary) p-4 text-sm">
      <h2 id="order-emails-title" className="font-bold">E-maily k objednávce</h2>
      <p className="text-(--color-fg-secondary)">Potvrzení a změny stavu posíláme na {email}.</p>
      {state.kind === "loading" && <p>Ověřuji odeslání potvrzovacího e-mailu…</p>}
      {state.kind === "unavailable" && <p>Stav e-mailů se nepodařilo ověřit.</p>}
      {state.kind === "ready" && state.deliveries.length === 0 && <p>Potvrzovací e-mail se připravuje k odeslání.</p>}
      {state.kind === "ready" && state.deliveries.length > 0 && (
        <ul className="grid gap-1">
          {state.deliveries.map((d) => (
            <li key={d.event} className="flex flex-wrap justify-between gap-2">
              <span>{eventLabels[d.event] ?? d.event}</span>
              <strong>{d.status === "SENT" && d.sentAt ? `${statusLabels.SENT} · ${formatTime(d.sentAt)}` : (statusLabels[d.status] ?? d.status)}</strong>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
