export type CategoryQuery = Record<string, string | string[] | undefined>;
export type CategoryFilters = ReturnType<typeof parseCategoryFilters>;
const first = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value[0] : value) ?? "";
const price = (value: string) => {
  const normalized = value.trim().replace(",", ".");
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return undefined;
  const minor = Math.round(Number(normalized) * 100);
  return Number.isSafeInteger(minor) && minor >= 0 ? minor : undefined;
};

export function parseCategoryFilters(query: CategoryQuery) {
  const min = first(query.min);
  const max = first(query.max);
  const sort = first(query.sort);
  const availability = first(query.availability);
  return {
    q: first(query.q).trim().slice(0, 200),
    min: price(min) === undefined ? "" : min,
    max: price(max) === undefined ? "" : max,
    minMinor: price(min),
    maxMinor: price(max),
    availability:
      availability === "in-stock" || availability === "out-of-stock" ? availability : "",
    sort: sort === "price-asc" || sort === "price-desc" ? sort : "name",
  };
}

export function categoryFilterParams(filters: CategoryFilters) {
  return Object.fromEntries(
    Object.entries({
      q: filters.q,
      min: filters.min,
      max: filters.max,
      availability: filters.availability,
      sort: filters.sort === "name" ? "" : filters.sort,
    }).filter(([, value]) => value),
  );
}
