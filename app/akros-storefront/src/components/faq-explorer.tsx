"use client";

import { useMemo, useState } from "react";
import { Input } from "@techsio/ui-kit/atoms/input";
import { Accordion } from "@techsio/ui-kit/molecules/accordion";

import { faqGroups } from "@/mock-storefront/fixtures/content";

const normalize = (value: string) =>
  value
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("cs-CZ");

export function FaqExplorer() {
  const [activeGroupId, setActiveGroupId] = useState<(typeof faqGroups)[number]["id"]>(
    faqGroups[0].id,
  );
  const [query, setQuery] = useState("");
  const normalizedQuery = normalize(query.trim());
  const activeGroup = faqGroups.find((group) => group.id === activeGroupId) ?? faqGroups[0];
  const visibleItems = useMemo(() => {
    if (!normalizedQuery) return activeGroup.items;

    return faqGroups.flatMap((group) =>
      group.items.filter(([question, answer]) =>
        normalize(`${question} ${answer}`).includes(normalizedQuery),
      ),
    );
  }, [activeGroup, normalizedQuery]);

  return (
    <>
      <div className="akros-faq-search">
        <Input
          aria-label="Hledat v často kladených otázkách"
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Hledejte v často kladených otázkách (např. normy, dodání, certifikáty)…"
          size="lg"
          type="search"
          value={query}
        />
      </div>
      <div className="akros-faq-layout">
        <nav aria-label="Kategorie často kladených otázek" className="akros-faq-categories">
          <h2>Kategorie témat</h2>
          {faqGroups.map((group) => (
            <button
              aria-current={!normalizedQuery && group.id === activeGroup.id ? "page" : undefined}
              key={group.id}
              onClick={() => {
                setActiveGroupId(group.id);
                setQuery("");
              }}
              type="button"
            >
              {group.title}
            </button>
          ))}
        </nav>
        <section className="akros-faq-results" aria-live="polite">
          <h2>{normalizedQuery ? "Výsledky hledání" : activeGroup.title}</h2>
          {visibleItems.length > 0 ? (
            <Accordion collapsible size="sm" variant="default">
              {visibleItems.map(([question, answer]) => (
                <Accordion.Item key={question} value={question}>
                  <Accordion.Header>
                    <Accordion.Title>{question}</Accordion.Title>
                    <Accordion.Indicator />
                  </Accordion.Header>
                  <Accordion.Content>{answer}</Accordion.Content>
                </Accordion.Item>
              ))}
            </Accordion>
          ) : (
            <p className="akros-empty-state">Pro zadaný výraz jsme nenašli žádnou odpověď.</p>
          )}
        </section>
      </div>
    </>
  );
}
