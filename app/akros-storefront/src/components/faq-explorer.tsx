"use client";

import { useMemo, useState } from "react";
import { Badge } from "@techsio/ui-kit/atoms/badge";
import { Input } from "@techsio/ui-kit/atoms/input";
import { Accordion } from "@techsio/ui-kit/molecules/accordion";

import { faqGroups } from "@/mock-storefront/fixtures/content";

const normalize = (value: string) =>
  value
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("cs-CZ");

const faqGroupIcons: Record<(typeof faqGroups)[number]["id"], string> = {
  doprava: "🚚",
  objednavky: "🛒",
  produkty: "⚙️",
  reklamace: "🔄",
};

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
      <header className="akros-faq-hero">
        <Badge size="md" variant="primary">
          ZÁKAZNICKÁ PODPORA
        </Badge>
        <h1>Jak vám můžeme dnes pomoci?</h1>
        <div className="akros-faq-search">
          <span aria-hidden="true" className="akros-faq-search__icon">
            🔍
          </span>
          <Input
            aria-label="Hledat v často kladených otázkách"
            className="akros-faq-search__input"
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Hledejte v často kladených otázkách (např. normy, dodání, certifikáty)…"
            size="md"
            type="search"
            value={query}
          />
        </div>
      </header>
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
              <span aria-hidden="true">{faqGroupIcons[group.id]}</span>
              {group.title}
            </button>
          ))}
        </nav>
        <section className="akros-faq-results" aria-live="polite">
          <h2>
            <span aria-hidden="true">{normalizedQuery ? "🔍" : faqGroupIcons[activeGroup.id]}</span>
            {normalizedQuery ? "Výsledky hledání" : activeGroup.title}
          </h2>
          {visibleItems.length > 0 ? (
            <div className="akros-faq-accordion-list">
              {visibleItems.map(([question, answer]) => (
                <Accordion collapsible key={question} shadow="none" size="sm" variant="default">
                  <Accordion.Item value={question}>
                    <Accordion.Header>
                      <Accordion.Title>
                        {question}
                        <Accordion.Subtitle className="akros-faq-answer-summary">
                          {answer}
                        </Accordion.Subtitle>
                      </Accordion.Title>
                      <Accordion.Indicator />
                    </Accordion.Header>
                    <Accordion.Content>{answer}</Accordion.Content>
                  </Accordion.Item>
                </Accordion>
              ))}
            </div>
          ) : (
            <p className="akros-empty-state">Pro zadaný výraz jsme nenašli žádnou odpověď.</p>
          )}
        </section>
      </div>
    </>
  );
}
