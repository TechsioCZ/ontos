// expect-count: 1
// B3/A6: same dynamic module route as successful output, but this is the diagnostic sink.
export async function reportFailure(message: string) {
 const { error: fail } = await import("node:console" as string);
 fail(message);
}
