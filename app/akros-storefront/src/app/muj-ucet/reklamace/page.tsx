import type { Metadata } from "next";
import { AccountLink } from "@/features/account/account-link";
import { AccountShell } from "@/components/account-shell";
import { AccountHeading, AccountPanel } from "@/features/account/account-content";

export const metadata: Metadata = { title: "Reklamace v účtu" };
export default function AccountClaimsPage() {
  return (
    <AccountShell active="claims">
      <AccountHeading
        title="Reklamace"
        description="Připravte si údaje k objednávce a popište problém."
      />
      <div className="grid gap-(--dimension-24) md:grid-cols-2">
        <AccountPanel title="Najděte objednávku">
          <p className="mb-(--dimension-24)">
            Poznamenejte si číslo objednávky, kód produktu a stručný popis závady.
          </p>
          <AccountLink
            href="/historie-objednavek"
            data-account-action
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            Otevřít objednávky
          </AccountLink>
        </AccountPanel>
        <AccountPanel title="Kontaktujte podporu">
          <p className="mb-(--dimension-24)">
            V kontaktním formuláři můžete připravit zprávu. V tomto prototypu se neodesílá.
          </p>
          <AccountLink href="/kontakty" data-account-action size="sm" variant="primary">
            Přejít na kontakty
          </AccountLink>
        </AccountPanel>
      </div>
    </AccountShell>
  );
}
