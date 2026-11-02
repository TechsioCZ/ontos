"use client";

import { useState } from "react";
import StoreLink from "@/components/store-link";
import { Button } from "@techsio/ui-kit/atoms/button";
import { Link } from "@techsio/ui-kit/atoms/link";
import { FormInput } from "@techsio/ui-kit/molecules/form-input";
import { Select } from "@techsio/ui-kit/molecules/select";
import { currencySymbol } from "@/lib/format";
import type { CategoryFilters as Filters } from "@/ontos/category-filters";
import { useDictionary, useMoney, useStoreHref } from "@/ontos/market-context";

export function CategoryFilters({
  filters,
  pathname,
  count,
}: {
  filters: Filters;
  pathname: string;
  count: number;
}) {
  const cs = useDictionary();
  const symbol = currencySymbol(useMoney());
  const href = useStoreHref();
  const availabilityOptions = [
    { value: "all", label: cs.filters.availabilityAll },
    { value: "in-stock", label: cs.filters.availabilityInStock },
    { value: "out-of-stock", label: cs.filters.availabilityOutOfStock },
  ];
  const sortOptions = [
    { value: "name", label: cs.filters.sortName },
    { value: "price-asc", label: cs.filters.sortPriceAsc },
    { value: "price-desc", label: cs.filters.sortPriceDesc },
  ];
  const [availability, setAvailability] = useState(filters.availability || "all");
  const [sort, setSort] = useState(filters.sort);
  const invalidRange =
    filters.minMinor !== undefined &&
    filters.maxMinor !== undefined &&
    filters.minMinor > filters.maxMinor;
  return (
    <form
      data-akros-category-filters
      action={href(pathname)}
      method="get"
      aria-label={cs.filters.formLabel}
      className="mb-6 grid min-w-0 gap-6 rounded-sm border-(length:--border-sm) border-base-dark bg-base p-6"
    >
      <div className="grid min-w-0 items-end gap-4 sm:grid-cols-2">
        <FormInput
          id="category-query"
          name="q"
          label={cs.filters.query}
          defaultValue={filters.q}
          size="sm"
          placeholder={cs.filters.queryPlaceholder}
        />
        <fieldset className="grid min-w-0 grid-cols-2 gap-3">
          <legend className="sr-only">{cs.filters.priceLegend}</legend>
          <FormInput
            id="category-min"
            name="min"
            label={cs.filters.priceFrom(symbol)}
            inputMode="decimal"
            pattern="[0-9]+([.,][0-9]{1,2})?"
            defaultValue={filters.min}
            size="sm"
            placeholder={cs.filters.pricePlaceholder}
          />
          <FormInput
            id="category-max"
            name="max"
            label={cs.filters.priceTo(symbol)}
            inputMode="decimal"
            pattern="[0-9]+([.,][0-9]{1,2})?"
            defaultValue={filters.max}
            size="sm"
            placeholder={cs.filters.pricePlaceholder}
          />
        </fieldset>
        <div className="grid min-w-0 grid-cols-1 gap-4 sm:col-span-2 sm:grid-cols-2">
          <Select
            className="akros-select"
            id="category-availability"
            items={availabilityOptions}
            value={[availability]}
            onValueChange={({ value }) => setAvailability(value[0] ?? "all")}
            size="sm"
          >
            <Select.Label>{cs.filters.availability}</Select.Label>
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
            className="akros-select"
            id="category-sort"
            items={sortOptions}
            value={[sort]}
            onValueChange={({ value }) => setSort(value[0] ?? "name")}
            size="sm"
          >
            <Select.Label>{cs.filters.sort}</Select.Label>
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
          {cs.filters.found}: <strong>{count}</strong>. {cs.catalog.filters.priceInformation}
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <Link as={StoreLink} href={pathname}>
            {cs.filters.clear}
          </Link>
          <Button type="submit" variant="primary" size="sm" uppercase>
            {cs.filters.submit}
          </Button>
        </div>
      </div>
      {invalidRange && (
        <p role="alert" className="text-sm text-(--color-danger)">
          {cs.filters.invalidRange}
        </p>
      )}
    </form>
  );
}
