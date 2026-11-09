/**
 * The SKOS profile's tools. Names, arguments and output are SKOS, whatever the backend.
 *
 * Every tool takes `vocab` (optional: a known vocabulary id or a service base URL) and
 * `response_format` ("markdown" for reading, "json" for programs). A concept is addressed by
 * the backend's local `id` or by its concept URI.
 */

import { z } from "zod";
import type { EngineContext, ToolResult, ToolSpec } from "@ondata-extended/profile-contract";
import type { Concept, ConceptRef, Note, SearchHit, VocabularyAdapter, VocabularyInstance } from "./model.js";
import { createResolver } from "./vocabularies.js";

const vocabArg = z.string().max(500).optional()
  .describe("Vocabulary to use: a known id (e.g. 'svada') or the base URL of a vocabulary service. Omit for the default vocabulary.");
const formatArg = z.enum(["markdown", "json"]).default("markdown")
  .describe("Output format: 'markdown' for reading, 'json' for structured data");
const idArg = z.string().min(1).max(500)
  .describe("The concept's id in the vocabulary (e.g. '10') or its concept URI as returned by these tools (e.g. 'https://begrepp.hagstrom.nu/skos/10'). A URI also selects its vocabulary when `vocab` is omitted. Get ids from vocab_search_concepts or vocab_suggest.");
const limitArg = z.number().int().min(1).max(200).default(50).describe("Maximum number of concepts to return (1-200, default 50)");

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

function resolve(ctx: EngineContext, vocab: string | undefined): { instance: VocabularyInstance; adapter: VocabularyAdapter } {
  return createResolver(ctx.config).resolve(vocab);
}

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

export class ForeignConceptUriError extends Error {
  constructor(uri: string, vocab: string) {
    super(`The concept URI "${uri}" does not belong to vocabulary "${vocab}".`);
    this.name = "ForeignConceptUriError";
  }
}

const hostOf = (u: string | undefined) => {
  try {
    return u ? new URL(u).hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The vocabulary and local id for a concept argument. A URI picks its vocabulary when `vocab`
 * is omitted (by host, among known vocabularies), and must belong to the chosen vocabulary;
 * otherwise a URI from elsewhere would silently resolve to a different concept with the same id.
 */
function resolveConcept(ctx: EngineContext, vocab: string | undefined, idOrUri: string) {
  const isUri = /^https?:\/\//i.test(idOrUri.trim());
  const resolver = createResolver(ctx.config);
  let chosen = vocab;
  if (isUri && !vocab) {
    const host = hostOf(idOrUri.trim());
    const known = host ? resolver.registry.byHostname(host) ?? resolver.registry.all().find((e) => hostOf(e.ext.conceptUriBase) === host) : undefined;
    if (known) chosen = known.id;
  }
  const { instance, adapter } = resolver.resolve(chosen);
  if (isUri) {
    const host = hostOf(idOrUri.trim());
    if (host !== hostOf(instance.baseUrl) && host !== hostOf(instance.conceptUriBase)) {
      throw new ForeignConceptUriError(idOrUri.trim(), instance.id);
    }
  }
  return { instance, adapter, id: localId(idOrUri) };
}

class ConceptNotFoundError extends Error {
  constructor(id: string, vocab: string) {
    super(`No concept with id "${id}" in vocabulary "${vocab}".`);
    this.name = "ConceptNotFoundError";
  }
}

// ---------------------------------------------------------------------------------------
// Markdown

function refLine(ctx: EngineContext, r: ConceptRef): string {
  return `- ${ctx.output.sanitizeInline(r.prefLabel)} (id \`${ctx.output.sanitizeInline(r.id)}\`)`;
}

function refList(ctx: EngineContext, title: string, refs: ConceptRef[]): string {
  if (refs.length === 0) return "";
  return `\n## ${title} (${refs.length})\n\n${refs.map((r) => refLine(ctx, r)).join("\n")}\n`;
}

const NOTE_TITLES: Record<Note["type"], string> = {
  definition: "Definition",
  scopeNote: "Scope note",
  historyNote: "History note",
  editorialNote: "Editorial note",
  changeNote: "Change note",
  example: "Example",
  note: "Note"
};

function conceptMarkdown(ctx: EngineContext, c: Concept, vocab: VocabularyInstance): string {
  const o = ctx.output;
  let md = `# ${o.sanitizeInline(c.prefLabel)}\n\n`;
  md += `- **URI**: ${o.safeUrlText(c.uri)}\n- **id**: \`${o.sanitizeInline(c.id)}\`\n- **Vocabulary**: ${o.sanitizeInline(vocab.id)}\n`;
  if (c.lang) md += `- **Language**: ${o.sanitizeInline(c.lang)}\n`;
  if (c.path.length > 1) md += `- **Path**: ${c.path.map((p) => o.sanitizeInline(p.prefLabel)).join(" › ")}\n`;
  if (c.altLabels.length) md += `- **Alternative labels**: ${c.altLabels.map((l) => o.sanitizeInline(l.value)).join("; ")}\n`;
  if (c.created) md += `- **Created**: ${o.sanitizeInline(c.created)}\n`;
  if (c.modified) md += `- **Modified**: ${o.sanitizeInline(c.modified)}\n`;
  if (c.ext.tematres && (c.ext.tematres as Record<string, unknown>).isMetaTerm) {
    md += "- **Grouping term**: yes (a TemaTres meta-term: it groups concepts and is not meant for indexing)\n";
  }
  for (const n of c.notes) {
    md += `\n## ${NOTE_TITLES[n.type]}${n.lang ? ` (${o.sanitizeInline(n.lang)})` : ""}\n\n${o.wrapUntrusted(n.value)}\n`;
  }
  md += refList(ctx, "Broader", c.broader);
  md += refList(ctx, "Narrower", c.narrower);
  md += refList(ctx, "Related", c.related);
  if (c.mappings.length) {
    md += `\n## Mappings (${c.mappings.length})\n\n`;
    md += c.mappings.map((m) => `- ${m.type}${m.label ? ` ${o.sanitizeInline(m.label)}` : ""}${m.uri ? ` ${o.safeUrlText(m.uri)}` : ""}${m.scheme ? ` in ${o.sanitizeInline(m.scheme)}` : ""}`).join("\n") + "\n";
  }
  return md;
}

function hitsMarkdown(ctx: EngineContext, title: string, hits: SearchHit[], total: number): string {
  const o = ctx.output;
  if (total === 0) return `# ${title}\n\nNo concepts found.`;
  let md = `# ${title}\n\n${total} concept(s)${hits.length < total ? `, showing ${hits.length}` : ""}.\n\n`;
  md += hits.map((h) => {
    let line = refLine(ctx, h);
    if (h.matchedLabel) line += ` — matched the alternative label "${o.sanitizeInline(h.matchedLabel)}"`;
    return line;
  }).join("\n");
  return md;
}

function respond(ctx: EngineContext, format: "markdown" | "json", json: unknown, markdown: () => string): ToolResult {
  return format === "json" ? ctx.output.json(json) : ctx.output.text(markdown());
}

// ---------------------------------------------------------------------------------------
// Tools

const searchConcepts: ToolSpec<{ query: z.ZodString; vocab: typeof vocabArg; limit: typeof limitArg; response_format: typeof formatArg }> = {
  name: "vocab_search_concepts",
  title: "Search concepts",
  description:
    "Search a controlled vocabulary (thesaurus, SKOS concept scheme) for concepts whose preferred or alternative labels contain the query. " +
    "Use it to find the concept for a word, then call vocab_get_concept with the id for its definition and relations. " +
    "Matches on alternative labels (synonyms, other languages) say which label matched. " +
    "Example: { query: 'data' }.",
  inputSchema: {
    query: z.string().min(2).max(200).describe("Text to look for in labels (at least two characters; case-insensitive, substring)"),
    vocab: vocabArg,
    limit: limitArg,
    response_format: formatArg
  },
  annotations: { title: "Search concepts", ...READ_ONLY },
  async handler(args, ctx) {
    const { instance, adapter } = resolve(ctx, args.vocab);
    const all = await adapter.search(ctx, instance, args.query);
    const shown = all.slice(0, args.limit);
    return respond(ctx, args.response_format, { vocab: instance.id, query: args.query, count: all.length, concepts: shown },
      () => hitsMarkdown(ctx, `Concepts matching "${ctx.output.sanitizeInline(args.query)}"`, shown, all.length));
  }
};

const suggest: ToolSpec<{ prefix: z.ZodString; vocab: typeof vocabArg; limit: typeof limitArg; response_format: typeof formatArg }> = {
  name: "vocab_suggest",
  title: "Suggest concepts",
  description:
    "Autocomplete: concepts whose labels start with or contain the given text, as a user types. " +
    "Prefer vocab_search_concepts for a whole word; use this for a fragment of a few letters. " +
    "TemaTres returns at most 50 suggestions, so the count is not a total. Example: { prefix: 'dat' }.",
  inputSchema: {
    prefix: z.string().min(2).max(100).describe("The beginning of a label (at least two characters; three or more gives better results)"),
    vocab: vocabArg,
    limit: z.number().int().min(1).max(50).default(50).describe("Maximum number of suggestions (1-50, default 50)"),
    response_format: formatArg
  },
  annotations: { title: "Suggest concepts", ...READ_ONLY },
  async handler(args, ctx) {
    const { instance, adapter } = resolve(ctx, args.vocab);
    const all = await adapter.suggest(ctx, instance, args.prefix);
    const shown = all.slice(0, args.limit);
    return respond(ctx, args.response_format, { vocab: instance.id, prefix: args.prefix, count: all.length, capped: all.length >= 50, concepts: shown },
      () => hitsMarkdown(ctx, `Suggestions for "${ctx.output.sanitizeInline(args.prefix)}"`, shown, all.length) +
        (all.length >= 50 ? "\n\nThe service returns at most 50 suggestions; type more letters to narrow them." : ""));
  }
};

const getConcept: ToolSpec<{ id: typeof idArg; vocab: typeof vocabArg; response_format: typeof formatArg }> = {
  name: "vocab_get_concept",
  title: "Get concept",
  description:
    "Everything about one concept: preferred and alternative labels, definition and other notes, broader, narrower and related concepts, " +
    "mappings to other vocabularies, and its path from the top of the hierarchy. Notes are text from the vocabulary service, shown as quoted data. " +
    "Example: { id: '10' }.",
  inputSchema: { id: idArg, vocab: vocabArg, response_format: formatArg },
  annotations: { title: "Get concept", ...READ_ONLY },
  async handler(args, ctx) {
    const { instance, adapter, id } = resolveConcept(ctx, args.vocab, args.id);
    const concept = await adapter.getConcept(ctx, instance, id);
    if (!concept) throw new ConceptNotFoundError(id, instance.id);
    ctx.telemetry.note({ concept_id: id });
    return respond(ctx, args.response_format, { vocab: instance.id, concept }, () => conceptMarkdown(ctx, concept, instance));
  }
};

function relationTool(
  name: string,
  title: string,
  description: string,
  pick: (a: VocabularyAdapter) => VocabularyAdapter["broader"]
): ToolSpec<{ id: typeof idArg; vocab: typeof vocabArg; response_format: typeof formatArg }> {
  return {
    name,
    title,
    description,
    inputSchema: { id: idArg, vocab: vocabArg, response_format: formatArg },
    annotations: { title, ...READ_ONLY },
    async handler(args, ctx) {
      const { instance, adapter, id } = resolveConcept(ctx, args.vocab, args.id);
      const refs = await pick(adapter).call(adapter, ctx, instance, id);
      if (refs === null) throw new ConceptNotFoundError(id, instance.id);
      return respond(ctx, args.response_format, { vocab: instance.id, id, concepts: refs }, () =>
        refs.length ? `# ${title} of concept ${ctx.output.sanitizeInline(id)}\n\n${refs.map((r) => refLine(ctx, r)).join("\n")}` : `# ${title} of concept ${ctx.output.sanitizeInline(id)}\n\nNone.`);
    }
  };
}

const broader = relationTool("vocab_broader", "Broader concepts",
  "The concepts directly above this one in the hierarchy (skos:broader). More than one when the vocabulary is polyhierarchical. " +
  "For the whole path to the top, use vocab_get_concept. Example: { id: '10' }.",
  (a) => a.broader);
const narrower = relationTool("vocab_narrower", "Narrower concepts",
  "The concepts directly below this one in the hierarchy (skos:narrower). Call again on a result to go deeper. Example: { id: '36' }.",
  (a) => a.narrower);
const related = relationTool("vocab_related", "Related concepts",
  "Concepts associated with this one outside the hierarchy (skos:related). Example: { id: '2' }.",
  (a) => a.related);

const topConcepts: ToolSpec<{ vocab: typeof vocabArg; response_format: typeof formatArg }> = {
  name: "vocab_top_concepts",
  title: "Top concepts",
  description:
    "The top of the vocabulary's hierarchy (skos:hasTopConcept): where to start browsing with vocab_narrower. " +
    "In TemaTres these are often grouping terms rather than concepts for indexing.",
  inputSchema: { vocab: vocabArg, response_format: formatArg },
  annotations: { title: "Top concepts", ...READ_ONLY },
  async handler(args, ctx) {
    const { instance, adapter } = resolve(ctx, args.vocab);
    const refs = await adapter.topConcepts(ctx, instance);
    return respond(ctx, args.response_format, { vocab: instance.id, concepts: refs }, () =>
      `# Top concepts of ${ctx.output.sanitizeInline(instance.id)}\n\n${refs.map((r) => refLine(ctx, r)).join("\n") || "None."}`);
  }
};

const schemeInfo: ToolSpec<{ vocab: typeof vocabArg; response_format: typeof formatArg }> = {
  name: "vocab_scheme_info",
  title: "Vocabulary information",
  description:
    "About the vocabulary itself (skos:ConceptScheme): title, URI, languages, number of concepts, dates, creator and the software it runs on. " +
    "Call it first to see what a vocabulary covers.",
  inputSchema: { vocab: vocabArg, response_format: formatArg },
  annotations: { title: "Vocabulary information", ...READ_ONLY },
  async handler(args, ctx) {
    const { instance, adapter } = resolve(ctx, args.vocab);
    const info = await adapter.schemeInfo(ctx, instance);
    return respond(ctx, args.response_format, { vocab: instance.id, scheme: info }, () => {
      const o = ctx.output;
      let md = `# ${o.sanitizeInline(info.title || instance.id)}\n\n- **URI**: ${o.safeUrlText(info.uri)}\n- **Id here**: ${o.sanitizeInline(instance.id)}\n`;
      if (info.languages.length) md += `- **Languages**: ${info.languages.map((l) => o.sanitizeInline(l)).join(", ")}\n`;
      if (info.conceptCount !== undefined) md += `- **Concepts**: ${info.conceptCount}\n`;
      if (info.created) md += `- **Created**: ${o.sanitizeInline(info.created)}\n`;
      if (info.modified) md += `- **Modified**: ${o.sanitizeInline(info.modified)}\n`;
      if (info.creator) md += `- **Creator**: ${o.sanitizeInline(info.creator)}\n`;
      if (info.publisher) md += `- **Publisher**: ${o.sanitizeInline(info.publisher)}\n`;
      if (info.rights) md += `- **Rights**: ${o.sanitizeInline(info.rights)}\n`;
      if (info.software) md += `- **Software**: ${o.sanitizeInline(info.software)}\n`;
      if (info.description) md += `\n${o.wrapUntrusted(info.description)}\n`;
      return md;
    });
  }
};

export const SKOS_TOOLS: ToolSpec<any>[] = [
  searchConcepts, getConcept, broader, narrower, related, topConcepts, suggest, schemeInfo
];

export { ConceptNotFoundError };
