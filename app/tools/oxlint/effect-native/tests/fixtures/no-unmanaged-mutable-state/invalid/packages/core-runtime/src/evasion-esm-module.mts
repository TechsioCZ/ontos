// expect-count: 1
// Coverage probe: the same C3 singleton in an explicit-ESM `.mts` module.
export let activeTenantId: string | undefined;

export const setTenant = (id: string): void => {
	activeTenantId = id;
};
