export interface SettingRow {
	readonly key: string;
}

/** Parameters, variables, fields, arrays and tuples are not service outcomes. */
export function enqueue(pending: Promise<SettingRow | undefined>): void {
	void pending;
}

export const inflight: Promise<SettingRow | null> = Promise.resolve(null);

export class SettingQueue {
	readonly pending: Promise<SettingRow | undefined> = Promise.resolve(undefined);
	private readonly batch: ReadonlyArray<Promise<SettingRow | undefined>> = [];
	size(): number {
		return this.batch.length;
	}
}

export type Batch = ReadonlyArray<Promise<SettingRow | undefined>>;
export type Pair = readonly [Promise<SettingRow | undefined>, number];
