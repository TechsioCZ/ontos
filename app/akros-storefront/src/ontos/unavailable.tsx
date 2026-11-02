"use client";
import type { Dictionary } from "@/i18n";
import { useDictionary } from "./market-context";

/**
 * `storeName`: the brand's name, absent when the root layout itself failed (global error, no brand chrome).
 * `dictionary`: the chrome language when no market provider is mounted (global error); else the market's.
 */
export function Unavailable({
  reset,
  storeName,
  dictionary,
}: {
  reset: () => void;
  storeName?: string;
  dictionary?: Dictionary;
}) {
  const marketDictionary = useDictionary();
  const copy = (dictionary ?? marketDictionary).errorPages;
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 24,
        background: "var(--color-base,#f3f4f6)",
        fontFamily: "var(--font-sf-ext),var(--font-sf,Arial),sans-serif",
      }}
    >
      <section
        style={{
          maxWidth: 620,
          padding: "40px 32px",
          borderRadius: 12,
          background: "white",
          border: "1px solid #e5e7eb",
          boxShadow: "0 8px 32px #00000008",
        }}
        aria-labelledby="unavailable-title"
      >
        <p style={{ fontWeight: 800, letterSpacing: 2, fontSize: 14, marginBottom: 24 }}>
          {storeName === undefined ? (
            "DEMO"
          ) : (
            <>
              {storeName} <span style={{ fontWeight: 400, letterSpacing: 0 }}>· DEMO</span>
            </>
          )}
        </p>
        <h1
          id="unavailable-title"
          style={{ fontSize: 28, lineHeight: 1.25, fontWeight: 700, marginBottom: 16 }}
        >
          {copy.unavailableTitle}
        </h1>
        <p style={{ fontSize: 16, lineHeight: 1.6, color: "#4b5563", marginBottom: 24 }}>
          {copy.unavailableText}
        </p>
        <button
          onClick={reset}
          style={{
            background: "var(--color-button-bg-primary-base,#b70e15)",
            color: "#111",
            fontSize: 16,
            fontWeight: 600,
            padding: "12px 24px",
            border: 0,
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          {copy.retry}
        </button>
        <p style={{ marginTop: 24, fontSize: 13, color: "#6b7280" }}>{copy.demoNote}</p>
      </section>
    </main>
  );
}
