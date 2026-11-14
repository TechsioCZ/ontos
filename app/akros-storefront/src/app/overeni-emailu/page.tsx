import type { Metadata } from "next";
import StoreLink from "@/components/store-link";
import { VerificationResendForm } from "@/components/verification-resend-form";
import { StorefrontWideShell } from "@/components/storefront-shell";
import { getDictionary } from "@/ontos/active-market";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: (await getDictionary()).auth.verification.title,
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  };
}

export default async function EmailVerificationPage({
  searchParams,
}: {
  searchParams: Promise<{ stav?: string | string[] }>;
}) {
  const { stav } = await searchParams;
  const copy = (await getDictionary()).auth.verification;
  const verified = stav === "overeno";
  const message = verified
    ? copy.verified
    : stav === "nedostupne"
      ? copy.unavailable
      : stav === "limit"
        ? copy.limit
        : stav === "podpora"
          ? copy.support
          : copy.invalid;
  return (
    <StorefrontWideShell>
      <section className="sf-auth-page">
        <div className="sf-auth-card">
          <h1>{verified ? copy.verifiedHeading : copy.notVerifiedHeading}</h1>
          <p>
            <output>{message}</output>
          </p>
          <p>
            <StoreLink href="/prihlaseni">{copy.goToLogin}</StoreLink>
          </p>
          {!verified && <VerificationResendForm />}
          {!verified && (
            <p>
              <StoreLink href="/kontakty">{copy.contactSupport}</StoreLink>
            </p>
          )}
        </div>
      </section>
    </StorefrontWideShell>
  );
}
