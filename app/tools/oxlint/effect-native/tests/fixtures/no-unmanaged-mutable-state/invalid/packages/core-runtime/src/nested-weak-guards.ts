// expect-count: 2
// Audit correction: D tier permits native local computation; Existing patterns to preserve
// explicitly blesses recursive JSON normalization. These fresh call-argument WeakSets are not
// evidence of an A4 cause/provenance/UI side channel. Only the two mutated module records report.
const normalise = (value: unknown, seen: WeakSet<object>): unknown => {
	if (typeof value !== "object" || value === null) return value;
	seen.add(value);
	return value;
};

export const hashOne = (value: unknown): unknown => normalise(value, new WeakSet());

export const hashMany = (values: readonly unknown[]): readonly unknown[] =>
	values.map((value) => normalise(value, new WeakSet<object>()));

const counters: Record<string, number> = {};
const leases: Record<string, string> = {};

export const bump = (): void => {
	counters.total++;
};

export const release = (key: string): void => {
	delete leases[key];
};

export const total = (): number => counters.total ?? 0;
