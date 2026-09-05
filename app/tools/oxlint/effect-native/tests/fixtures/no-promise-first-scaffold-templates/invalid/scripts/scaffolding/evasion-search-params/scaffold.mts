// expect-count: 1
/**
 * A9 evasion: A9's target is "Schema-driven route/search parameters through Schema.standardSchemaV1",
 * but the `routeParams` group is gated on the literal word `RouteParams`, so the identical
 * all-optional string record emitted for *search* parameters is never scanned.
 */
export const renderSearch = (component: string, keys: string): string => `import { useSearch } from '@modern-js/runtime/router';

type ${component}SearchParams = Readonly<Partial<Record<${keys}, string>>>;

export const use${component}Search = (): ${component}SearchParams => useSearch();
`;
