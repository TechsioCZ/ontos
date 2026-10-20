"use client";
import { Unavailable } from "@/ontos/unavailable";
export default function GlobalError({ reset }: { reset: () => void }) {
  return (
    <html lang="cs">
      <body style={{ margin: 0 }}>
        <Unavailable reset={reset} />
      </body>
    </html>
  );
}
