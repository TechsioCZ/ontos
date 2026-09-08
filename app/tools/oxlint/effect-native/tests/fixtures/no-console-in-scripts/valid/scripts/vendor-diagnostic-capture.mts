// Audit D: forced vendor save/patch/restore is interception, not emission.
declare function vendor(): void;
export function capture() {
 const saved = console.warn;
 console.warn = () => {};
 try { vendor(); } finally { console.warn = saved; }
}
