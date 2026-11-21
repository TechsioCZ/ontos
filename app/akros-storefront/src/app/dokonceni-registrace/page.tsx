import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { EnrollmentProgress } from "@/components/enrollment-progress";
import { StorefrontWideShell } from "@/components/storefront-shell";
import { readRequestAccount } from "@/ontos/account";
import { getDictionary, marketHref } from "@/ontos/active-market";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getDictionary()).auth.enrollment.title };
}

/**
 * Sign-in lands here. A customer Commerce already admits goes straight to the account; anyone else (an enrollment still
 * in progress, or an admission that cannot be read now) gets the progress checks, which recheck and redirect themselves.
 */
export default async function EnrollmentProgressPage() {
  const account = await readRequestAccount().catch(() => null);
  if (account !== null) redirect(await marketHref("/muj-ucet"));
  const copy = (await getDictionary()).auth.enrollment;
  return (
    <StorefrontWideShell>
      <section className="sf-auth-page">
        <div className="sf-auth-card">
          <header>
            <h1>{copy.title}</h1>
            <p>{copy.subtitle}</p>
          </header>
          <EnrollmentProgress />
        </div>
      </section>
    </StorefrontWideShell>
  );
}
