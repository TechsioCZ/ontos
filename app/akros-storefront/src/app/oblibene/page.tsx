import type { Metadata } from "next";
import { AccountLink } from "@/features/account/account-link";
import { AccountShell } from "@/components/account-shell";
import { FavoritesList } from "@/features/favorites/favorites-list";
import { AccountHeading } from "@/features/account/account-content";

export const metadata: Metadata = { title: "Oblíbené produkty" };
export default async function FavoritesPage() {
  return (
    <AccountShell active="favorites">
      <AccountHeading
        title="Oblíbené produkty"
        description="Vaše oblíbené varianty uložené v tomto prohlížeči."
      >
        <AccountLink
          href="/muj-ucet/prehled"
          data-account-action
          size="sm"
          theme="outlined"
          variant="secondary"
        >
          Zpět na přehled
        </AccountLink>
      </AccountHeading>
      <FavoritesList />
    </AccountShell>
  );
}
