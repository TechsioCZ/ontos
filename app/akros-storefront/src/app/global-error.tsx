"use client";
import { Unavailable } from "@/ontos/unavailable";
export default function GlobalError({ reset }: { reset: () => void }) {
  return (
    <html lang="cs">
      <head>
        <title>Katalog je dočasně nedostupný | AKROS DEMO</title>
        <meta name="robots" content="noindex, nofollow, noarchive" />
      </head>
      <body style={{ margin: 0 }}>
        <Unavailable reset={reset} />
      </body>
    </html>
  );
}
