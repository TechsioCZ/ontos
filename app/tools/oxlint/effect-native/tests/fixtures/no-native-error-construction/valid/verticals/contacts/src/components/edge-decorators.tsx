// Decorators, JSX fragments and generic call expressions: parser-shape probes with no native error.
import type { ReactNode } from "react";

function logged(value: unknown, _context: unknown): unknown {
	return value;
}

export class Presenter {
	@logged
	render(): string {
		return "ok";
	}
}

export const identity = <T,>(value: T): T => value;

export function Panel(): ReactNode {
	return (
		<>
			<span>{identity<string>("ok")}</span>
		</>
	);
}
