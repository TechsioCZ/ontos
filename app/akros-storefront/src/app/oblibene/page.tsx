import type { Metadata } from "next";
import { AccountLink } from "@/features/account/account-link";
import { AccountShell } from "@/components/account-shell";
import { FavoritesList } from "@/features/favorites/favorites-list";
import { AccountHeading } from "@/features/account/account-content";
import { getDictionary } from "@/ontos/active-market";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getDictionary()).favorites.pageTitle };
}

/** Browser-saved favorite variants; their catalogue data is read live from OntOS by the list. */
export default async function FavoritesPage() {
  const cs = await getDictionary();
  return (
    <AccountShell active="favorites">
      <AccountHeading title={cs.favorites.pageTitle} description={cs.favorites.pageDescription}>
        <AccountLink
          href="/muj-ucet/prehled"
          data-account-action
          size="sm"
          theme="outlined"
          variant="secondary"
        >
          {cs.favorites.backToOverview}
        </AccountLink>
      </AccountHeading>
      <FavoritesList />
    </AccountShell>
  );
}
