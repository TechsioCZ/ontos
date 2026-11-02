"use client";

import { useMemo, useState } from "react";
import { Badge } from "@techsio/ui-kit/atoms/badge";
import { Input } from "@techsio/ui-kit/atoms/input";
import { Accordion } from "@techsio/ui-kit/molecules/accordion";

import type { FaqGroupId, FaqGroups } from "@/content/editorial";

const normalize = (value: string) =>
  value
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("cs-CZ");

const faqGroupIcons: Record<FaqGroupId, string> = {
  doprava: "🚚",
  objednavky: "🛒",
  produkty: "⚙️",
  reklamace: "🔄",
};

/** `faqGroups`: the shop FAQ with the brand's contact (server page: `faqGroups(inquiryEmail)`). */
export function FaqExplorer({ faqGroups }: { faqGroups: FaqGroups }) {
  const [activeGroupId, setActiveGroupId] = useState<FaqGroupId>(faqGroups[0].id);
  const [query, setQuery] = useState("");
  const normalizedQuery = normalize(query.trim());
  const activeGroup = faqGroups.find((group) => group.id === activeGroupId) ?? faqGroups[0];
  const visibleItems = useMemo(() => {
    if (!normalizedQuery) return activeGroup.items;

    return faqGroups.flatMap((group) =>
      group.items.filter(([question, answer, details]) =>
        normalize(`${question} ${answer} ${details.join(" ")}`).includes(normalizedQuery),
      ),
    );
  }, [activeGroup, faqGroups, normalizedQuery]);

  return (
    <>
      <header className="sf-faq-hero">
        <Badge size="md" variant="primary">
          ZÁKAZNICKÁ PODPORA
        </Badge>
        <h1>Jak vám můžeme dnes pomoci?</h1>
        <div className="sf-faq-search">
          <span aria-hidden="true" className="sf-faq-search__icon">
            🔍
          </span>
          <Input
            aria-label="Hledat v často kladených otázkách"
            className="sf-faq-search__input"
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Hledejte v často kladených otázkách (např. normy, dodání, certifikáty)…"
            size="md"
            type="search"
            value={query}
          />
        </div>
      </header>
      <div className="sf-faq-layout">
        <nav aria-label="Kategorie často kladených otázek" className="sf-faq-categories">
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
        <section className="sf-faq-results" aria-live="polite">
          <h2>
            <span aria-hidden="true">{normalizedQuery ? "🔍" : faqGroupIcons[activeGroup.id]}</span>
            {normalizedQuery ? "Výsledky hledání" : activeGroup.title}
          </h2>
          {visibleItems.length > 0 ? (
            <div className="sf-faq-accordion-list">
              {visibleItems.map(([question, answer, details]) => (
                <Accordion collapsible key={question} shadow="none" size="sm" variant="default">
                  <Accordion.Item value={question}>
                    <Accordion.Header>
                      <Accordion.Title>
                        {question}
                        <Accordion.Subtitle className="sf-faq-answer-summary">
                          {answer}
                        </Accordion.Subtitle>
                      </Accordion.Title>
                      <Accordion.Indicator />
                    </Accordion.Header>
                    <Accordion.Content>
                      <div className="sf-faq-answer-details">
                        {details.map((paragraph) => (
                          <p key={paragraph}>{paragraph}</p>
                        ))}
                      </div>
                    </Accordion.Content>
                  </Accordion.Item>
                </Accordion>
              ))}
            </div>
          ) : (
            <p className="sf-empty-state">Pro zadaný výraz jsme nenašli žádnou odpověď.</p>
          )}
        </section>
      </div>
    </>
  );
}
