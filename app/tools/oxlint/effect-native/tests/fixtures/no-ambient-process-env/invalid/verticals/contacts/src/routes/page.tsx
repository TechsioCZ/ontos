// expect-count: 4
// A3: the bundler-injected variant of the same anti-pattern, in a TSX route.
export function ContactsPage() {
	const apiUrl = import.meta.env.VITE_CONTACTS_API_URL;
	const mode = import.meta.env["MODE"];
	const flag = process.env.PUBLIC_CONTACTS_FLAG;
	return <div data-api={apiUrl} data-mode={mode} data-flag={flag} data-all={String(import.meta.env)} />;
}
