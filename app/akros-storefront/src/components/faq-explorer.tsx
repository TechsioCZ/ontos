"use client";

import { useMemo, useState } from "react";
import { Badge } from "@techsio/ui-kit/atoms/badge";
import { Button } from "@techsio/ui-kit/atoms/button";
import { Input } from "@techsio/ui-kit/atoms/input";
import { Accordion } from "@techsio/ui-kit/molecules/accordion";

import type { FaqCopy, FaqGroupId } from "@/content/editorial";

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

/** The shop FAQ in the page's language (server page: `faqCopy[locale](inquiryEmail)`). */
export function FaqExplorer({ faq }: { faq: FaqCopy }) {
  const { chrome, groups: faqGroups } = faq;
  const [activeGroupId, setActiveGroupId] = useState<FaqGroupId>(faqGroups[0].id);
  const [query, setQuery] = useState("");
  const normalizedQuery = normalize(query.trim());
  const activeGroup = faqGroups.find((group) => group.id === activeGroupId) ?? faqGroups[0];
  const visibleItems = useMemo(() => {
    if (!normalizedQuery) return activeGroup.items;

    return faqGroups.flatMap((group) =>
      group.items.filter((item) =>
        normalize(`${item.question} ${item.answer} ${item.details.join(" ")}`).includes(
          normalizedQuery,
        ),
      ),
    );
  }, [activeGroup, faqGroups, normalizedQuery]);

  return (
    <>
      <header className="sf-faq-hero">
        <Badge size="md" variant="primary">
          {chrome.badge}
        </Badge>
        <h1>{chrome.heading}</h1>
        <div className="sf-faq-search">
          <span aria-hidden="true" className="sf-faq-search__icon">
            🔍
          </span>
          <Input
            aria-label={chrome.searchLabel}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={chrome.searchPlaceholder}
            size="md"
            type="search"
            value={query}
          />
        </div>
      </header>
      <div className="sf-faq-layout">
        <nav aria-label={chrome.categoriesLabel} className="sf-faq-categories">
          <h2>{chrome.categoriesHeading}</h2>
          {faqGroups.map((group) => (
            <Button
              aria-current={!normalizedQuery && group.id === activeGroup.id ? "page" : undefined}
              key={group.id}
              theme="borderless"
              variant="secondary"
              size="sm"
              className="justify-start"
              onClick={() => {
                setActiveGroupId(group.id);
                setQuery("");
              }}
              type="button"
            >
              <span aria-hidden="true">{faqGroupIcons[group.id]}</span>
              {group.title}
            </Button>
          ))}
        </nav>
        <section className="sf-faq-results" aria-live="polite">
          <h2>
            <span aria-hidden="true">{normalizedQuery ? "🔍" : faqGroupIcons[activeGroup.id]}</span>
            {normalizedQuery ? chrome.resultsHeading : activeGroup.title}
          </h2>
          {visibleItems.length > 0 ? (
            <div className="sf-faq-accordion-list">
              {visibleItems.map((item) => (
                <Accordion
                  collapsible
                  key={item.question}
                  shadow="none"
                  size="sm"
                  variant="default"
                >
                  <Accordion.Item value={item.question}>
                    <Accordion.Header>
                      <Accordion.Title>
                        {item.question}
                        <Accordion.Subtitle className="sf-faq-answer-summary">
                          {item.answer}
                        </Accordion.Subtitle>
                      </Accordion.Title>
                      <Accordion.Indicator />
                    </Accordion.Header>
                    <Accordion.Content>
                      <div className="sf-faq-answer-details">
                        {item.details.map((paragraph) => (
                          <p key={paragraph}>{paragraph}</p>
                        ))}
                      </div>
                    </Accordion.Content>
                  </Accordion.Item>
                </Accordion>
              ))}
            </div>
          ) : (
            <p className="sf-empty-state">{chrome.noResults}</p>
          )}
        </section>
      </div>
    </>
  );
}
