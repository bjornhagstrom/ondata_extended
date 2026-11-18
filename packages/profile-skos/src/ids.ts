/** Concept ids: the local id in a concept URI. */

/** A local id from an id or a concept URI (`.../skos/10`, `...?term_id=10`, `...?tema=10`). */
export function localId(idOrUri: string): string {
  const v = idOrUri.trim();
  if (/^https?:\/\//i.test(v)) {
    try {
      const u = new URL(v);
      const param = u.searchParams.get("term_id") ?? u.searchParams.get("tema");
      if (param) return param;
      const last = u.pathname.replace(/\/+$/, "").split("/").pop() ?? "";
      return decodeURIComponent(last);
    } catch {
      return v;
    }
  }
  return v;
}
