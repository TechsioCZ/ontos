// `includeFetch` defaults to false: ambient fetch is not itself the hand-built-server anti-pattern.
export async function load(url: string): Promise<unknown> {
	const response = await fetch(url);
	return response.json();
}
