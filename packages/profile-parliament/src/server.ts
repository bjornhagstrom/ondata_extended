/**
 * Ported from ondata/italianparliament-mcp src/server.ts at fd46810 (MIT, see NOTICE.md): the MCP
 * side of a tool (`makeHandler`, `formatResult`, the empty-result text, the annotations).
 *
 * Reach changed: the tools are handed to the core as `ToolSpec`s with a `handler`, instead of
 * being registered on an McpServer here; the core registers them (name, title, description with
 * the examples appended exactly as `describe()` did, input schema, annotations). The handler is
 * the original's, so the text a client gets is the original's: JSONL rows in the tools' own key
 * order, the truncation notice after them, `Error: ...` on failure, no structured channel and no
 * character cap (the core's table output would project columns, add `structuredContent` and cut
 * at the character limit). The handler takes the engine context and gives it to `execute`.
 * Not ported: `createServer`/`registerAll` (the host builds the server) and the 39 tools not yet
 * in this profile.
 */

import { ZodError, type AnyZodObject } from "zod";
import type { EngineContext, ToolResult as McpToolResult, ToolSpec } from "@ondata-extended/profile-contract";
import type { Tool, ToolResult } from "./tools/types.js";
import { toJsonl } from "./core/format.js";
import { SparqlError } from "./core/client.js";
import { formatZodError } from "./core/zod-error.js";
import { withTruncationNotice, limitCeiling } from "./core/truncation.js";

export const DEFAULT_EMPTY =
  "Nessun risultato dai dati. NON dedurre né inventare il valore: se serve, riformula (termine normativo o radice più corta per le ricerche testuali, filtro più largo) o verifica gli identificatori (URI/numero/ramo). Un vuoto è spesso un mismatch, non un dato assente.";

export function formatResult(result: ToolResult, emptyHint?: string): string {
  if (result.rows.length === 0) return result.hint ?? emptyHint ?? DEFAULT_EMPTY;
  // L'avviso di troncamento va accodato al JSONL, non sostituito: qui le righe
  // ci sono, manca solo la coda dell'intervallo. Il lettore è un LLM, che senza
  // questa riga presenterebbe un elenco tagliato come se fosse completo.
  return result.notice
    ? `${toJsonl(result.rows)}\n${result.notice}`
    : toJsonl(result.rows);
}

export function makeHandler(tool: Tool) {
  return async (input: unknown, ctx: EngineContext): Promise<McpToolResult> => {
    try {
      // Valida l'input con lo schema Zod prima di eseguire, come fa la CLI
      // (cli.ts). Le regex/limiti dello schema (es. il formato data YYYY-MM-DD
      // di speeches) non devono dipendere dal solo dispatch dell'SDK: parseare
      // qui è il chokepoint unico che protegge tutti i tool da input non
      // conformi che finirebbero interpolati nelle query SPARQL.
      const parsed = tool.inputSchema.parse(input);
      const { limit, offset } = parsed as { limit?: number; offset?: number };
      const result = withTruncationNotice(
        await tool.execute(parsed, ctx),
        limit,
        offset,
        limitCeiling(tool.inputSchema),
      );
      return {
        content: [
          { type: "text" as const, text: formatResult(result, tool.emptyHint) },
        ],
      };
    } catch (err) {
      const message =
        err instanceof ZodError
          ? formatZodError(err)
          : err instanceof SparqlError
            ? `SPARQL error on ${err.endpoint}${err.status ? ` (HTTP ${err.status})` : ""}: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  };
}

/**
 * A ported tool as the core registers it. Ogni tool qui è una lettura: interroga gli endpoint
 * SPARQL o le pagine pubbliche di Camera e Senato e non scrive nulla da nessuna parte, `sparql`
 * incluso (accetta solo SELECT). Quindi readOnlyHint ovunque e nessun destructiveHint, che ha
 * senso solo per i tool che scrivono. `openWorldHint` perché le fonti sono servizi esterni: i
 * risultati cambiano nel tempo e possono non rispondere.
 */
export function toToolSpec(tool: Tool): ToolSpec {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    examples: tool.examples,
    // Every tool's schema is a z.object (the original registered `.shape` too).
    inputSchema: (tool.inputSchema as AnyZodObject).shape,
    annotations: {
      title: tool.title,
      readOnlyHint: true,
      openWorldHint: true,
    },
    handler: makeHandler(tool),
  };
}
