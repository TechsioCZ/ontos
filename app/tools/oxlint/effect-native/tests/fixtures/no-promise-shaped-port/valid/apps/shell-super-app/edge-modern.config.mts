/** `*.config.mts` is ignored configuration, not a port. */
export interface ModernConfig {
	readonly setup: () => Promise<void>;
}

export const config = { setup: async () => await Promise.resolve() };
