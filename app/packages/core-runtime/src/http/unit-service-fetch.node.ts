import type { UnitRoutedFetch, UnitServiceFetch } from './unit-service-fetch.ts';

/** Node reaches every unit at its configured URL. */
export const unitServiceFetch: UnitServiceFetch = () => globalThis.fetch;

export const unitRoutedFetch: UnitRoutedFetch = () => globalThis.fetch;
