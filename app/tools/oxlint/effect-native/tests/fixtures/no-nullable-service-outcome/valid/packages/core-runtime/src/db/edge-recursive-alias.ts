export interface SettingRow {
	readonly key: string;
}

/** Cyclic and self-referential aliases must terminate without a report. */
type Cycle = Ping;
type Ping = Pong;
type Pong = Cycle;
type SelfUnion = SelfUnion | SettingRow;

/** Beyond the default `aliasDepth` of 3 hops the alias is not followed. */
type Deep1 = Deep2;
type Deep2 = Deep3;
type Deep3 = Deep4;
type Deep4 = SettingRow | undefined;

export interface CyclicPorts {
	readonly cycle: () => Promise<Cycle>;
	readonly selfish: () => Promise<SelfUnion>;
	readonly deep: () => Promise<Deep1>;
}
