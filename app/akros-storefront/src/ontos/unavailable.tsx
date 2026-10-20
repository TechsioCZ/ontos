"use client";
export function Unavailable({ reset }: { reset: () => void }) {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 24,
        background: "var(--color-base,#f3f4f6)",
        fontFamily: "var(--font-akros,Arial),sans-serif",
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
          AKROS <span style={{ fontWeight: 400, letterSpacing: 0 }}>· DEMO</span>
        </p>
        <h1
          id="unavailable-title"
          style={{ fontSize: 28, lineHeight: 1.25, fontWeight: 700, marginBottom: 16 }}
        >
          Katalog je dočasně nedostupný
        </h1>
        <p style={{ fontSize: 16, lineHeight: 1.6, color: "#4b5563", marginBottom: 24 }}>
          Spojení s OntOS se nepodařilo. Ceny ani sklad nenahrazujeme ukázkovými daty. Váš košík
          zůstává uložený v prohlížeči.
        </p>
        <button
          onClick={reset}
          style={{
            background: "var(--color-button-bg-primary-base,#b70e15)",
            color: "white",
            fontSize: 16,
            fontWeight: 600,
            padding: "12px 24px",
            border: 0,
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          Zkusit znovu
        </button>
        <p style={{ marginTop: 24, fontSize: 13, color: "#6b7280" }}>
          DEMO – objednávka nebude doručena.
        </p>
      </section>
    </main>
  );
}
