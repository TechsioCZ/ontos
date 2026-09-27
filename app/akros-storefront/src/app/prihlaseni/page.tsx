import type { Metadata } from "next";
import NextLink from "next/link";

import { MockLoginForm } from "@/components/mock-auth-form";
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
          <MockLoginForm />
          <div className="akros-auth-divider">
            <span>nebo</span>
          </div>
          <p>
            Ještě u nás nemáte účet? <NextLink href="/registrace">Vytvořte si ho zde</NextLink>
          </p>
        </div>
      </section>
    </StorefrontWideShell>
  );
}
