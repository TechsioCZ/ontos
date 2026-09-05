/** JSX text and attributes are strings, not expressions. */
export function Docs() {
	return <p title="new Date()">Date.now() is banned; use DateTime.now</p>;
}
