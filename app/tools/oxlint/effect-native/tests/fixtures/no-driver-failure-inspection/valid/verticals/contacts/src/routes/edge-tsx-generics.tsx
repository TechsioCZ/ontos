import type { ReactElement } from 'react';

const identity = <T,>(value: T): T => value;

export function Panel({ label }: { readonly label: string }): ReactElement {
	return (
		<>
			<section aria-label={identity(label)} data-code="ok">
				{[1, 2].map((n) => (
					<span key={n}>{`${n}`}</span>
				))}
			</section>
		</>
	);
}
