// expect-count: 4
import proc from "node:process";
import { exit } from "node:process";

const Banner = ({ label }: { label: string }) => <p>{label}</p>;

export const renderReport = (ok: boolean): void => {
	if (!ok) {
		proc["exit"](1);
	}
	globalThis.process?.exit?.(2);
	exit(3);
	queueMicrotask(process.exit);
	void Banner;
};
