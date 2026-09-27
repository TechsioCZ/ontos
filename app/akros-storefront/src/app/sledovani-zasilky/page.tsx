import type { Metadata } from "next";
import Image from "next/image";

import { AccountShell } from "@/components/account-shell";
import { mockTrackingEvents, mockTrackingSteps } from "@/mock-storefront/fixtures/account";

export const metadata: Metadata = { title: "Sledování zásilky" };

export default function TrackingPage() {
  return (
    <AccountShell active="tracking">
      <header className="akros-account-heading">
        <div>
          <h1>Sledování zásilky</h1>
          <p>
            Číslo zásilky PPL: <strong>PPL-2024-84129</strong>
          </p>
        </div>
      </header>
      <ol className="akros-tracking-steps">
        {mockTrackingSteps.map((step, index) => (
          <li data-complete={step.complete || undefined} key={step.title}>
            <b>{index + 1}</b>
            <strong>{step.title}</strong>
            <small>{step.detail}</small>
          </li>
        ))}
      </ol>
      <div className="akros-tracking-layout">
        <figure className="akros-tracking-map">
          <Image
            alt="Trasa zásilky mezi Prahou a Ostravou"
            height={660}
            src="/akros/content/tracking-map.png"
            width={820}
          />
          <figcaption>
            Aktuální odhadovaná poloha kurýra: Depo Ostrava — doručení na adresu
          </figcaption>
        </figure>
        <section className="akros-tracking-history">
          <h2>Historie pohybů zásilky</h2>
          <ol>
            {mockTrackingEvents.map((event) => (
              <li key={event.time}>
                <strong>{event.time}</strong>
                <span>{event.text}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </AccountShell>
  );
}
