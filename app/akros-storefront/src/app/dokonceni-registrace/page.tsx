import type { Metadata } from "next";
import { EnrollmentProgress } from "@/components/enrollment-progress";
import { StorefrontWideShell } from "@/components/storefront-shell";

export const metadata: Metadata = { title: "Dokončení registrace" };

export default function EnrollmentProgressPage() {
  return (
    <StorefrontWideShell>
      <section className="akros-auth-page">
        <div className="akros-auth-card">
          <header>
            <h1>Dokončení registrace</h1>
            <p>Stav vašeho účtu v tomto obchodě</p>
          </header>
          <EnrollmentProgress />
        </div>
      </section>
    </StorefrontWideShell>
  );
}
