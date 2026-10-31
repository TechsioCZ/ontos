import type { ReactNode } from "react";

export function AccountHeading({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="mb-(--dimension-32) flex flex-wrap items-start justify-between gap-(--dimension-24)">
      <div className="min-w-0">
        <h1 className="text-(length:--akros-account-section-size) font-bold leading-(--akros-account-heading-leading)">
          {title}
        </h1>
        {description && (
          <p className="mt-(--dimension-12) text-(--akros-account-muted)">{description}</p>
        )}
      </div>
      {children && (
        <div className="flex max-w-full flex-wrap gap-(--dimension-16) [&>a]:h-auto [&>a]:min-h-(--akros-account-action-height) [&>a]:max-w-full [&>a]:whitespace-normal [&>a]:leading-(--akros-account-heading-leading)">
          {children}
        </div>
      )}
    </header>
  );
}

export function AccountPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-(--dimension-8) bg-(--akros-account-surface) p-(--dimension-24) max-sm:p-(--dimension-16)">
      <h2 className="mb-(--dimension-24) text-(length:--akros-account-section-size) font-bold leading-(--akros-account-heading-leading)">
        {title}
      </h2>
      {children}
    </section>
  );
}
