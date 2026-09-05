// expect-count: 2
// Evasion: the mutable module container is produced by a call rather than by a literal or `new`.
// `Object.create(null)` dictionaries and copied arrays are the usual spellings.
const SEED: readonly string[] = ["boot"];

const runtimeByTenant = Object.create(null) as Record<string, string>;
const auditTrail = SEED.slice();

export const remember = (tenantId: string, runtimeId: string): void => {
	runtimeByTenant[tenantId] = runtimeId;
	auditTrail.push(runtimeId);
};

export const runtimeFor = (tenantId: string): string | undefined => runtimeByTenant[tenantId];
export const trail = (): readonly string[] => auditTrail;
