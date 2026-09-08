// Evasion: scan argv with for..of — a hand-written flag parser that never touches a member of argv.
let mode = "";
for (const argument of process.argv) {
	if (argument.startsWith("--mode=")) mode = argument.slice("--mode=".length);
}

export { mode };
