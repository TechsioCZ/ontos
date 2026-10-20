"use client";

import { useState } from "react";
import NextLink from "next/link";
import { Button } from "@techsio/ui-kit/atoms/button";
import { Link } from "@techsio/ui-kit/atoms/link";
import { FormInput } from "@techsio/ui-kit/molecules/form-input";
import { Select } from "@techsio/ui-kit/molecules/select";
import type { CategoryFilters as Filters } from "@/ontos/category-filters";

const availabilityOptions = [
  { value: "all", label: "Všechny produkty" },
  { value: "in-stock", label: "Skladem" },
  { value: "out-of-stock", label: "Není skladem" },
];
const sortOptions = [
  { value: "name", label: "Název A–Z" },
  { value: "price-asc", label: "Cena od nejnižší" },
  { value: "price-desc", label: "Cena od nejvyšší" },
];

export function CategoryFilters({
  filters,
  pathname,
  count,
}: {
  filters: Filters;
  pathname: string;
  count: number;
}) {
  const [availability, setAvailability] = useState(filters.availability || "all");
  const [sort, setSort] = useState(filters.sort);
  const invalidRange =
    filters.minMinor !== undefined &&
    filters.maxMinor !== undefined &&
    filters.minMinor > filters.maxMinor;
  return (
    <form
      action={pathname}
      method="get"
      aria-label="Filtrování produktů"
      className="mb-6 grid min-w-0 gap-4 rounded-sm border-(length:--border-sm) border-base-dark bg-base p-4"
    >
      <div className="grid min-w-0 items-end gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <FormInput
          id="category-query"
          name="q"
          label="Název nebo SKU"
          defaultValue={filters.q}
          size="sm"
          placeholder="Hledat v kategorii"
        />
        <fieldset className="grid min-w-0 grid-cols-2 gap-3">
          <legend className="sr-only">Cena za jednotku s DPH</legend>
          <FormInput
            id="category-min"
            name="min"
            label="Cena od (Kč)"
            inputMode="decimal"
            pattern="[0-9]+([.,][0-9]{1,2})?"
            defaultValue={filters.min}
            size="sm"
            placeholder="Bez omezení"
          />
          <FormInput
            id="category-max"
            name="max"
            label="Cena do (Kč)"
            inputMode="decimal"
            pattern="[0-9]+([.,][0-9]{1,2})?"
            defaultValue={filters.max}
            size="sm"
            placeholder="Bez omezení"
          />
        </fieldset>
        <div className="grid min-w-0 grid-cols-1 gap-4 sm:col-span-2 sm:grid-cols-2 lg:col-span-1">
          <Select
            id="category-availability"
            items={availabilityOptions}
            value={[availability]}
            onValueChange={({ value }) => setAvailability(value[0] ?? "all")}
            size="sm"
          >
            <Select.Label>Dostupnost</Select.Label>
            <Select.Control>
              <Select.Trigger>
                <Select.ValueText />
              </Select.Trigger>
            </Select.Control>
            <Select.Positioner>
              <Select.Content>
                {availabilityOptions.map((item) => (
                  <Select.Item key={item.value} item={item}>
                    <Select.ItemText>{item.label}</Select.ItemText>
                    <Select.ItemIndicator />
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Positioner>
          </Select>
          <Select
            id="category-sort"
            items={sortOptions}
            value={[sort]}
            onValueChange={({ value }) => setSort(value[0] ?? "name")}
            size="sm"
          >
            <Select.Label>Řazení</Select.Label>
            <Select.Control>
              <Select.Trigger>
                <Select.ValueText />
              </Select.Trigger>
            </Select.Control>
            <Select.Positioner>
              <Select.Content>
                {sortOptions.map((item) => (
                  <Select.Item key={item.value} item={item}>
                    <Select.ItemText>{item.label}</Select.ItemText>
                    <Select.ItemIndicator />
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Positioner>
          </Select>
        </div>
      </div>
      <input type="hidden" name="availability" value={availability === "all" ? "" : availability} />
      <input type="hidden" name="sort" value={sort} />
      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-base-dark pt-4">
        <p className="text-sm text-(--color-fg-secondary)">
          Nalezeno produktů: <strong>{count}</strong>. Cena za jednotku s DPH, u variant nejnižší
          cena „od“.
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <Link as={NextLink} href={pathname}>
            Vymazat filtry
          </Link>
          <Button type="submit" variant="primary" size="sm" uppercase>
            Filtrovat
          </Button>
        </div>
      </div>
      {invalidRange && (
        <p role="alert" className="text-sm text-(--color-danger)">
          Cena od nesmí být vyšší než cena do. Upravte rozsah nebo vymažte filtry.
        </p>
      )}
    </form>
  );
}
