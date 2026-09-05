// expect-count: 1
// C1 JSON-LD embedding written through a cast host, the shape SSR-safe code reaches for.
interface Props {
	readonly ldDocument: Record<string, unknown>;
}

export function LdHead({ ldDocument }: Props) {
	const json = (globalThis as unknown as { readonly JSON: typeof JSON }).JSON.stringify(ldDocument);
	return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}
