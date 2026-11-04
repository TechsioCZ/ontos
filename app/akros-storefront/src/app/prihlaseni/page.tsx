import type { Metadata } from "next";
import { getBrand } from "@/brand";

import { AuthPageLink, LoginForm } from "@/components/auth-form";
import { StorefrontWideShell } from "@/components/storefront-shell";
import { getDictionary } from "@/ontos/active-market";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getDictionary()).auth.loginTitle };
}

export default async function LoginPage() {
  const copy = (await getDictionary()).auth;
  return (
    <StorefrontWideShell>
      <section className="sf-auth-page">
        <div className="sf-auth-card">
          <header>
            <h1>{copy.loginHeading}</h1>
            <p>{copy.welcomeBack(getBrand().name)}</p>
          </header>
          <LoginForm />
          <p>
            <AuthPageLink href="/zapomenute-heslo">{copy.forgotPassword}</AuthPageLink>
          </p>
          <div className="sf-auth-divider">
            <span>{copy.or}</span>
          </div>
          <p>
            {copy.noAccount}{" "}
            <AuthPageLink href="/registrace">{copy.createAccountLink}</AuthPageLink>
          </p>
        </div>
      </section>
    </StorefrontWideShell>
  );
}
