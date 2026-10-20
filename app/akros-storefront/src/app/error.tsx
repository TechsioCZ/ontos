"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main style={{ maxWidth: 760, margin: "80px auto", padding: 24 }}>
      <h1>Katalog je dočasně nedostupný</h1>
      <p>
        Spojení s OntOS se nepodařilo. Ceny ani sklad nenahrazujeme ukázkovými daty. Zkuste to
        prosím za chvíli.
      </p>
      <button onClick={reset}>Zkusit znovu</button>
    </main>
  );
}
