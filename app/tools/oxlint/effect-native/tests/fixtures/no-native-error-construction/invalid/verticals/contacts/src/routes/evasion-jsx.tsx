// expect-count: 3
// TSX: a constructor inside a JSX attribute expression and inside a JSX child expression container.
import type { ReactNode } from "react";

export function RetryPanel({ onFail }: { readonly onFail: (cause: unknown) => void }): ReactNode {
	return (
		<>
			<button type="button" onClick={() => onFail(new Error("jsx attribute expression"))}>
				retry
			</button>
			{new TypeError("jsx child expression") instanceof Error ? "yes" : "no"}
		</>
	);
}
