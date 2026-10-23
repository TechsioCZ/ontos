import type { Metadata } from "next";
import StoreLink from "@/components/store-link";
import { VerificationResendForm } from "@/components/verification-resend-form";
import { StorefrontWideShell } from "@/components/storefront-shell";

export const metadata: Metadata = {
  title: "Ověření e-mailu",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function EmailVerificationPage({
  searchParams,
}: {
  searchParams: Promise<{ stav?: string | string[] }>;
}) {
  const { stav } = await searchParams;
  const verified = stav === "overeno";
  const message = verified
    ? "Váš e-mail byl úspěšně ověřen. Nyní se můžete přihlásit ke svému účtu."
    : stav === "nedostupne"
      ? "Ověření e-mailu je dočasně nedostupné. Zkuste prosím znovu otevřít odkaz z e-mailu později."
      : stav === "limit"
        ? "Příliš mnoho pokusů o ověření. Zkuste prosím znovu otevřít odkaz z e-mailu později."
        : stav === "podpora"
          ? "E-mail se nepodařilo ověřit. Pro dokončení ověření prosím kontaktujte naši podporu."
          : "Odkaz pro ověření e-mailu je neplatný, již použitý nebo jeho platnost vypršela. Můžete požádat o nový ověřovací e-mail.";
  return (
    <StorefrontWideShell>
      <section className="akros-auth-page">
        <div className="akros-auth-card">
          <h1>{verified ? "E-mail byl ověřen" : "E-mail nebyl ověřen"}</h1>
          <p>
            <output>{message}</output>
          </p>
          <p>
            <StoreLink href="/prihlaseni">Přejít k přihlášení</StoreLink>
          </p>
          {!verified && <VerificationResendForm />}
          {!verified && (
            <p>
              <StoreLink href="/kontakty">Kontaktovat podporu</StoreLink>
            </p>
          )}
        </div>
      </section>
    </StorefrontWideShell>
  );
}
