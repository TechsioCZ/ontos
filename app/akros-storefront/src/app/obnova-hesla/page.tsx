import type { Metadata } from "next";
import { cookies } from "next/headers";

import { AuthPageLink } from "@/components/auth-form";
import { PasswordResetForm } from "@/components/password-reset-form";
import { StorefrontWideShell } from "@/components/storefront-shell";
import { getDictionary } from "@/ontos/active-market";
import { passwordResetCookieName } from "@/ontos/account";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: (await getDictionary()).auth.passwordResetTitle,
    robots: { follow: false, index: false },
  };
}

export default async function PasswordResetPage() {
  const copy = (await getDictionary()).auth;
  const hasLink = (await cookies()).has(passwordResetCookieName);
  return (
    <StorefrontWideShell>
      <section className="sf-auth-page">
        <div className="sf-auth-card">
          <header>
            <h1>{copy.passwordResetHeading}</h1>
            {hasLink ? <p>{copy.passwordResetIntro}</p> : <p>{copy.passwordResetLinkMissing}</p>}
          </header>
          {hasLink ? (
            <PasswordResetForm />
          ) : (
            <p>
              <AuthPageLink href="/zapomenute-heslo">{copy.requestNewResetLink}</AuthPageLink>
            </p>
          )}
        </div>
      </section>
    </StorefrontWideShell>
  );
}
