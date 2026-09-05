// Audit/source correction: The dynamic node:console log export is successful output just like console.log; current script policy preserves both.
// B3/A6: `await import("node:console")` reaches exactly the same object as the static import the
// rule already tracks.
export async function emit(message: string): Promise<void> {
	const { log } = await import("node:console");
	log(message);
}
