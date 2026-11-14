import type { Metadata } from "next";

import { AuthPageLink, RegistrationForm } from "@/components/auth-form";
import { StorefrontWideShell } from "@/components/storefront-shell";
import { getDictionary } from "@/ontos/active-market";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getDictionary()).auth.registrationTitle };
}

export default async function RegistrationPage() {
  const copy = (await getDictionary()).auth;
  const benefits = [
    copy.benefits.orders,
    copy.benefits.faster,
    copy.benefits.discounts,
    copy.benefits.wishlist,
  ];
  return (
    <StorefrontWideShell>
      <section className="sf-registration-page">
        <div className="sf-registration-card">
          <header>
            <h1>{copy.registrationHeading}</h1>
            <p>{copy.registrationIntro}</p>
          </header>
          <RegistrationForm />
          <p>
            {copy.alreadyRegistered}{" "}
            <AuthPageLink href="/prihlaseni">{copy.loginLink}</AuthPageLink>
          </p>
        </div>
        <aside className="sf-benefit-card">
          <h2>{copy.benefitsTitle}</h2>
          <ul>
            {benefits.map(({ title, text }) => (
              <li key={title}>
                <strong>{title}</strong>
                <span>{text}</span>
              </li>
            ))}
          </ul>
        </aside>
      </section>
    </StorefrontWideShell>
  );
}
