/**
 * Ported from ondata/italianparliament-mcp src/core/types.ts at fd46810 (MIT, see NOTICE.md).
 * The SPARQL result types are the core's (packages/core/src/sparql.ts, the same shape), `Row` the
 * contract's (the same `Record<string, string>`).
 */

export type { SparqlBindingValue, SparqlResults } from "@ondata-extended/core";
export type { Row } from "@ondata-extended/profile-contract";
