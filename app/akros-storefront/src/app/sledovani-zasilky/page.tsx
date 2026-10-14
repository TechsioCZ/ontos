import type { Metadata } from "next";
import Image from "next/image";
import { AccountLink } from "@/features/account/account-link";
import { AccountShell } from "@/components/account-shell";
import { AccountHeading, AccountPanel } from "@/features/account/account-content";
import { mockTrackingEvents, mockTrackingSteps } from "@/mock-storefront/fixtures/account";

export const metadata: Metadata = { title: "Sledování zásilky" };
export default function TrackingPage() {
  return (
    <AccountShell active="tracking">
      <AccountHeading
        title="Sledování zásilky"
        description={<>Objednávka #2024-00847 · Zásilka PPL-2024-84129</>}
      >
        <AccountLink
          href="/detail-objednavky"
          data-account-action
          size="sm"
          theme="outlined"
          variant="secondary"
        >
          Detail objednávky
        </AccountLink>
      </AccountHeading>
      <ol
        aria-label="Průběh doručení"
        className="mb-(--dimension-32) grid gap-(--dimension-16) md:grid-cols-3 xl:grid-cols-5"
      >
        {mockTrackingSteps.map((step, index) => (
          <li
            key={step.title}
            aria-current={index === 3 ? "step" : undefined}
            className="flex items-center gap-(--dimension-16) rounded-(--dimension-8) bg-(--akros-account-surface) p-(--dimension-16)"
          >
            <span
              aria-hidden="true"
              className={`flex size-(--dimension-40) shrink-0 items-center justify-center rounded-full font-bold ${step.complete ? "bg-(--akros-account-accent)" : "border border-(--akros-account-muted) text-(--akros-account-muted)"}`}
            >
              {index + 1}
            </span>
            <div className="min-w-0">
              <p className="font-bold">{step.title}</p>
              <p className="text-(length:--dimension-16) text-(--akros-account-muted)">
                {step.detail}
              </p>
            </div>
          </li>
        ))}
      </ol>
      <div className="grid gap-(--dimension-24) lg:grid-cols-2">
        <AccountPanel title="Přehled doručení">
          <p className="mb-(--dimension-24)">Zásilka je na cestě. Očekávané doručení dnes.</p>
          <figure>
            <Image
              alt="Ukázková trasa zásilky mezi Prahou a Ostravou"
              height={660}
              width={820}
              src="/akros/content/tracking-map.png"
              className="h-auto w-full rounded-(--dimension-8)"
              sizes="(max-width: 1023px) 100vw, 800px"
            />
            <figcaption className="mt-(--dimension-16) text-(length:--dimension-16) text-(--akros-account-muted)">
              Ukázková poloha kurýra: Depo Ostrava. Údaje nejsou živě napojené na dopravce.
            </figcaption>
          </figure>
        </AccountPanel>
        <AccountPanel title="Historie zásilky">
          <ol className="grid gap-(--dimension-24)">
            {mockTrackingEvents.map((event) => (
              <li
                key={event.time}
                className="border-b border-(--akros-account-list-divider) pb-(--dimension-24) last:border-0 last:pb-0"
              >
                <p className="mb-(--dimension-8) font-bold">{event.time}</p>
                <p className="text-(--akros-account-muted)">{event.text}</p>
              </li>
            ))}
          </ol>
        </AccountPanel>
      </div>
    </AccountShell>
  );
}
