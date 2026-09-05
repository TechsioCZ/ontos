// EVASION: `sqlStatePattern` `^[0-9]{2}[0-9A-Z]{3}$` requires two leading digits, but real
// PostgreSQL SQLSTATE classes include `P0` (PL/pgSQL RAISE), `XX` (internal error), `HV` (FDW),
// `F0` (config file) and `0A`/`2B`/`3F`-style classes. `P0001` is the most common hand-written one.
// Fix: an explicit class allowlist, e.g. `^(?:[0-9]{2}|0[A-Z]|2[BDF]|3[BDFZ]|F0|HV|P0|XX)[0-9A-Z]{3}$`.
export const raised = (error: { readonly code: string }): boolean =>
	error.code === 'P0001' || error.code === 'XX000' || error.code === 'HV000' || error.code === 'F0000';
