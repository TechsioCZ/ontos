import type { Metadata } from "next";
import { EnrollmentProgress } from "@/components/enrollment-progress";
import { StorefrontWideShell } from "@/components/storefront-shell";
import { getDictionary } from "@/ontos/active-market";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getDictionary()).auth.enrollment.title };
}

export default async function EnrollmentProgressPage() {
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
