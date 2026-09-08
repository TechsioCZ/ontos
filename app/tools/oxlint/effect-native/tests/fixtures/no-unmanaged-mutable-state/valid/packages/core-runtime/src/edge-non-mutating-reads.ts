// Module-level containers that are only read or copied are not mutable state.
const seededOrder = ["actor", "decision"];
const labelByStatus = new Map([["installed", "Installed"]]);
const evidenceKeys = new Set(["actor"]);

export const withExtra = seededOrder.concat(["scope"]);
export const upper = seededOrder.map((entry) => entry.toUpperCase());
export const firstTwo = seededOrder.slice(0, 2);
export const joined = seededOrder.join(",");
export const labelFor = (status: string): string | undefined => labelByStatus.get(status);
export const isEvidence = (key: string): boolean => evidenceKeys.has(key);
export const entries = [...labelByStatus.entries()];
