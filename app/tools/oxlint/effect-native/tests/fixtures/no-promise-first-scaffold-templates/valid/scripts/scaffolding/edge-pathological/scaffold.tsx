/** Crash probe: empty, interpolation-only, escape-heavy, nested and JSX-embedded template literals. */
const a = 'x';
const b = 'y';

const empty = ``;
const onlyInterpolations = `${a}${b}`;
const escapes = `A\n\t\\\`\${not-an-interpolation}`;
const nested = `${`${a}`}`;
const raw = String.raw`\d+\n${a}`;

export const Panel = ({ label }: { readonly label: string }) => (
	<section data-label={`${label}-${empty}${onlyInterpolations}${escapes}${nested}${raw}`}>
		<span>{`  `}</span>
	</section>
);
