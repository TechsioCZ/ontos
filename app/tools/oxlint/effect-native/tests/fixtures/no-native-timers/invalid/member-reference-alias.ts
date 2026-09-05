// expect-count: 3
// Capturing a native timer still imports its unmanaged lifetime into the program.
const later = (globalThis as typeof globalThis).setTimeout;
later(() => {}, 1);
(0, globalThis[`setInterval`])(() => {}, 1);
const immediate = globalThis.window.setImmediate;
