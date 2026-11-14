"use client";
import { useEffect, useState } from "react";
import type { Dictionary } from "@/i18n";
import { useDictionary, useMoney } from "@/ontos/market-context";

type Receipt = { event: string; eventLabel?: string | null; status: string; sentAt: string | null };
type State =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "ready"; deliveries: Receipt[] };
type EmailCopy = Dictionary["checkout"]["emails"];
const label = (labels: Readonly<Record<string, string>>, key: string) =>
  Object.hasOwn(labels, key) ? labels[key] : undefined;
/** The dispatcher labels pickup orders „Připraveno k vyzvednutí“ instead of „Předáno dopravci“. */
const receiptLabel = (d: Receipt, copy: EmailCopy) =>
  d.event === "SHIPPED" && d.eventLabel === "Připraveno k vyzvednutí"
    ? copy.pickupReady
    : (label(copy.events, d.event) ?? d.event);
const formatTime = (iso: string, locale: string) =>
  new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Prague",
  }).format(new Date(iso));

export function OrderEmailStatus({ email, orderNumber }: { email: string; orderNumber: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const copy = useDictionary().checkout.emails;
  const { locale } = useMoney();
  useEffect(() => {
    let cancelled = false;
    let polls = 0;
    const load = async () => {
      try {
        const response = await fetch(
          `/api/ontos/order-emails?${new URLSearchParams({ email, orderNumber }).toString()}`,
          { cache: "no-store" },
        );
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
      if (polls > 60) {
        window.clearInterval(timer);
        return;
      }
      void load();
    }, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [email, orderNumber]);
  return (
    <section
      aria-labelledby="order-emails-title"
      className="grid grid-cols-1 gap-2 rounded-sm border border-(--color-border-primary) p-4 text-sm"
    >
      <h2 id="order-emails-title" className="font-bold">
        {copy.title}
      </h2>
      <p className="wrap-anywhere text-(--color-fg-secondary)">{copy.recipient(email)}</p>
      {state.kind === "loading" && <p>{copy.loading}</p>}
      {state.kind === "unavailable" && <p>{copy.unavailable}</p>}
      {state.kind === "ready" && state.deliveries.length === 0 && <p>{copy.preparing}</p>}
      {state.kind === "ready" && state.deliveries.length > 0 && (
        <ul className="grid gap-1">
          {state.deliveries.map((d) => (
            <li key={d.event} className="flex flex-wrap justify-between gap-2">
              <span>{receiptLabel(d, copy)}</span>
              <strong>
                {d.status === "SENT" && d.sentAt
                  ? `${copy.statuses.SENT} · ${formatTime(d.sentAt, locale)}`
                  : (label(copy.statuses, d.status) ?? d.status)}
              </strong>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
