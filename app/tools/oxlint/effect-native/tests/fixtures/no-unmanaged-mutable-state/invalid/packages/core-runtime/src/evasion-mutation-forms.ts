// expect-count: 2
// Evasion: the module container is mutated through methods outside the default `mutatingMembers`
// list (`sort`/`reverse`/`fill`) and through `Object.assign`, so it reads as "seeded read-only".
const rankedTenants = ["core", "contacts"];
const featureFlags: Record<string, boolean> = { legacyOutbox: false };

export const rerank = (): void => {
	rankedTenants.sort();
	rankedTenants.reverse();
};

export const applyFlags = (patch: Record<string, boolean>): void => {
	Object.assign(featureFlags, patch);
};

export const ranking = (): readonly string[] => rankedTenants;
export const isEnabled = (flag: string): boolean => featureFlags[flag] === true;
