// Seeded read-only lookup tables and frozen constants are blessed by the audit's
// "native array/object operations where Effect collection APIs add no semantic value".
const nonBypassableReasons = new Set(["policy", "scope"]);
const evidenceKeys = new Set<string>(["actor", "decision"]);
const statusLabels = new Map([["installed", "Installed"]]);
const frozenDefaults = Object.freeze({ retries: 3 });
const frozenOrder = Object.freeze(["actor", "decision"]);

export const publicRoutes = [] as const;
export const emptyIndex = {} as Readonly<Record<string, string>>;

export const isNonBypassable = (reason: string): boolean => nonBypassableReasons.has(reason);
export const isEvidenceKey = (key: string): boolean => evidenceKeys.has(key);
export const labelFor = (status: string): string | undefined => statusLabels.get(status);
export const retries = frozenDefaults.retries;
export const order = frozenOrder.join(",");
export const routeCount = publicRoutes.length;
export const indexKeys = Object.keys(emptyIndex);
