import type { Metadata } from "next";

import { AccountShell } from "@/components/account-shell";
import { mockCustomer, mockOrderLines } from "@/mock-storefront/fixtures/account";

export const metadata: Metadata = { title: "Detail objednávky #2024-00847" };

export default function OrderDetailPage() {
  return (
    <AccountShell active="orders">
      <header className="akros-account-heading">
        <div>
          <h1>Detail objednávky #2024-00847</h1>
          <p>Vytvořeno 28. 10. 2026 o 14:32</p>
        </div>
        <a href="#objednane-polozky">Stáhnout fakturu PDF</a>
      </header>
      <section className="akros-order-progress" aria-label="Průběh doručení">
        {["Přijato", "Zpracováno", "Odesláno", "Doručeno"].map((step, index) => (
          <span key={step}>
            <b>{index + 1}</b>
            {step}
          </span>
        ))}
      </section>
      <section className="akros-address-grid">
        <article>
          <h2>Fakturační adresa</h2>
          <p>
            {mockCustomer.name}
            <br />
            Nerezová s.r.o. (IČO: 8412095)
            <br />
            {mockCustomer.address}
            <br />
            Česká republika
          </p>
        </article>
        <article>
          <h2>Doručovací adresa</h2>
          <p>
            Stavební Sklad AKROS
            <br />K rukám: Petra Horáka
            <br />
            Hutní prostranství 56
            <br />
            Ostrava, Česká republika
          </p>
        </article>
      </section>
      <section className="akros-order-meta">
        <div>
          <span>Způsob dopravy</span>
          <strong>PPL přepravní služba</strong>
        </div>
        <div>
          <span>Způsob platby</span>
          <strong>Kartou online (GP WebPay)</strong>
        </div>
      </section>
      <section className="akros-order-detail-card" id="objednane-polozky">
        <h2>Objednané položky</h2>
        {mockOrderLines.map((line) => (
          <article key={line.code}>
            <div>
              <strong>{line.name}</strong>
              <small>Kód: {line.code}</small>
            </div>
            <span>{line.quantity}</span>
            <span>{line.unitPrice}</span>
            <strong>{line.total}</strong>
          </article>
        ))}
        <dl>
          <div>
            <dt>Celkem bez DPH:</dt>
            <dd>1 297 Kč</dd>
          </div>
          <div>
            <dt>DPH (21 %):</dt>
            <dd>272 Kč</dd>
          </div>
          <div>
            <dt>Celkem s DPH:</dt>
            <dd>1 569 Kč</dd>
          </div>
        </dl>
      </section>
    </AccountShell>
  );
}
