// expect-count: 3
// A7: operational scripts write topology/authorization evidence with ad-hoc serialization.
import { writeFileSync } from "node:fs";

interface RolloutReport {
	readonly checked: number;
	readonly failures: readonly string[];
}

export const writeReport = (path: string, report: RolloutReport): void => {
	writeFileSync(path, JSON.stringify(report, null, 2));
};

export const summarise = (report: RolloutReport): void => {
	console.log(JSON.stringify({ checked: report.checked }));
};

export const digest = (report: RolloutReport): string => JSON.stringify(report.failures);
