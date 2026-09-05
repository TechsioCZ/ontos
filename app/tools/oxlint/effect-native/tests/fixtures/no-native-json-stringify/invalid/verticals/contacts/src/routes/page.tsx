// expect-count: 2
// C1: JSON-LD embedding plus a hash key derived from ad-hoc serialization, in a TSX route.
interface PageProps {
	readonly ldDocument: Record<string, unknown>;
	readonly filters: Record<string, string>;
}

export function ContactsPage({ ldDocument, filters }: PageProps) {
	const filtersHash = JSON.stringify(filters);
	return (
		<section data-filters={filtersHash}>
			<script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ldDocument) }} />
		</section>
	);
}
