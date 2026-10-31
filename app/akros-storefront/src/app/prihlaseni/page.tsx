import type { Metadata } from "next";
import StoreLink from "@/components/store-link";

import { LoginForm } from "@/components/auth-form";
import { StorefrontWideShell } from "@/components/storefront-shell";

export const metadata: Metadata = { title: "Přihlášení" };

export default function LoginPage() {
  return (
    <StorefrontWideShell>
      <section className="akros-auth-page">
        <div className="akros-auth-card">
          <header>
            <h1>Přihlášení partnera</h1>
            <p>Vítejte zpět v e-shopu AKROS</p>
          </header>
          <LoginForm />
          <div className="akros-auth-divider">
            <span>nebo</span>
          </div>
          <p>
            Ještě u nás nemáte účet? <StoreLink href="/registrace">Vytvořte si ho zde</StoreLink>
          </p>
        </div>
      </section>
    </StorefrontWideShell>
  );
}
