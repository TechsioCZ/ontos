/**
 * A search result opens the Shell record page with the found title in history state (not in the URL, so a
 * crafted link cannot dictate it). When the owning module offers no Shell detail view, the page names the
 * record and points to its agendas instead of calling an existing record missing.
 */
/**
 * Link state updater: keeps the router's own history keys and adds the found title. A hit whose
 * governed name is not visible (O17, O58) carries no title at all rather than a fabricated one.
 */
export const searchHitState =
  (title: string | undefined) =>
  <State extends object>(previous: State) =>
    title === undefined ? previous : { ...previous, searchHitTitle: title };
