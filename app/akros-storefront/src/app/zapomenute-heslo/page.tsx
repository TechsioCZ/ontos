import type { Metadata } from "next";

import { AuthPageLink } from "@/components/auth-form";
import { PasswordRequestForm } from "@/components/password-reset-form";
import { StorefrontWideShell } from "@/components/storefront-shell";
import { getDictionary } from "@/ontos/active-market";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: (await getDictionary()).auth.passwordRequestTitle,
    robots: { follow: false, index: false },
  };
}

export default async function PasswordRequestPage() {
  const copy = (await getDictionary()).auth;
  return (
    <StorefrontWideShell>
      <section className="sf-auth-page">
        <div className="sf-auth-card">
          <header>
            <h1>{copy.passwordRequestHeading}</h1>
            <p>{copy.passwordRequestIntro}</p>
          </header>
          <PasswordRequestForm />
          <p>
            <AuthPageLink href="/prihlaseni">{copy.backToLogin}</AuthPageLink>
          </p>
        </div>
      </section>
    </StorefrontWideShell>
  );
}
