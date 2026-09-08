// expect-count: 7
export interface SettingRow {
	readonly key: string;
}

export type SettingRepos = {
	readonly [K in "settings" | "flags"]: () => Promise<SettingRow | undefined>;
};

export interface SettingPorts {
	load<T>(key: string): Promise<T | undefined>;
	reversed(): Promise<undefined | SettingRow>;
	nested(): Promise<SettingRow | (SettingRow | null)>;
	parenthesised(): Promise<((SettingRow | undefined))>;
	likely(): PromiseLike<SettingRow | undefined>;
	inline(): Promise<{ readonly key: string } | undefined>;
}
