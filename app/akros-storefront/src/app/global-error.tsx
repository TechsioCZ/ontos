"use client";
import { Unavailable } from "@/ontos/unavailable";
export default function GlobalError({ reset }: { reset: () => void }) {
  return (
    <html lang="cs">
      <head>
        {/* Replaces the root layout, so no brand is known here: a brand-neutral title. */}
        <title>Katalog je dočasně nedostupný | DEMO</title>
        <meta name="robots" content="noindex, nofollow, noarchive" />
      </head>
      <body style={{ margin: 0 }}>
        <Unavailable reset={reset} />
      </body>
    </html>
  );
}
