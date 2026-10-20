"use client";
export default function GlobalError({ reset }: { reset: () => void }) {
  return (
    <html lang="cs">
      <body>
        <main style={{ maxWidth: 760, margin: "80px auto", padding: 24, fontFamily: "sans-serif" }}>
          <h1>Katalog je dočasně nedostupný</h1>
          <p>
            Spojení s OntOS se nepodařilo. Ceny ani sklad nenahrazujeme ukázkovými daty. Zkuste to
            prosím za chvíli.
          </p>
          <button onClick={reset}>Zkusit znovu</button>
        </main>
      </body>
    </html>
  );
}
