/**
 * The SKOS profile's tools. Names, arguments and output are SKOS, whatever the backend.
 *
 * Every tool takes `vocab` (optional: a known vocabulary id or a service base URL) and
 * `response_format` ("markdown" for reading, "json" for programs). A concept is addressed by
 * the backend's local `id` or by its concept URI.
 */

import { z } from "zod";
import type { EngineContext, InstanceEntry, ToolResult, ToolSpec } from "@ondata-extended/profile-contract";
import type { Concept, ConceptRef, Note, SearchHit, VocabularyAdapter, VocabularyInstance } from "./model.js";
import { createResolver, type VocabExt } from "./vocabularies.js";
import { localId } from "./ids.js";

export { localId };

type Entries = readonly InstanceEntry<VocabExt>[];
const vocabArgBase = z.string().max(500).optional();
const MAX_LISTED = 20;

/** "'id' (Title), …" for at most MAX_LISTED entries, with the rest counted. */
function listed(entries: Entries): string {
  const shown = entries.slice(0, MAX_LISTED).map((e) => `'${e.id}'${e.ext.title ? ` (${e.ext.title})` : ""}`).join(", ");
  return entries.length > MAX_LISTED ? `${shown}, and ${entries.length - MAX_LISTED} more` : shown;
}

/**
 * Server instructions for the model, from the deployment's vocabularies: when to use these tools instead of memory or a
 * web search, and how to cite. `extra` is the deployment's own addition (what its vocabularies are for), appended.
 */
export function skosInstructions(entries: Entries, extra?: string): string {
  const where = entries.length
    ? `the controlled vocabularies ${listed(entries)} (and other vocabulary services the server may reach, by base URL)`
    : "controlled vocabularies on a vocabulary service, given by its base URL";
  const text =
    `These vocab_ tools read ${where}, live from the vocabulary service (SKOS: concepts, labels, definitions and notes, ` +
    "broader, narrower and related concepts, mappings to other vocabularies and languages). " +
    "When the user asks about one of these vocabularies, or the work at hand uses one (what a term means in it, its preferred " +
    "label, its place in the hierarchy, its neighbours, its equivalent in another language), look it up with these tools " +
    "instead of answering from memory or searching the web: vocab_search_concepts first, then vocab_get_concept. In the " +
    "answer, use the vocabulary's preferred terms, quote definitions and scope notes as given, and say which vocabulary the " +
    "answer comes from. If the vocabulary has no matching concept, say so rather than filling the gap from memory. For " +
    "general questions about words that do not involve these vocabularies, the tools are not needed.";
  return extra?.trim() ? `${text}\n\n${extra.trim()}` : text;
}

/** The `vocab` argument, described with the deployment's own vocabularies, so a model knows which ids exist. */
export function vocabArgDescription(entries: Entries): string {
  if (entries.length === 0) {
    return "Vocabulary to use: the base URL of a vocabulary service (e.g. 'https://vocab.example.org/').";
  }
  return `Vocabulary to use: a known id: ${listed(entries)}; or the base URL of another vocabulary service this server may reach. ` +
    `Omit for the default vocabulary ('${entries[0].id}').`;
}
const formatArg = z.enum(["markdown", "json"]).default("markdown")
  .describe("Output format: 'markdown' for reading, 'json' for structured data");
const idArg = z.string().min(1).max(500)
  .describe("The concept's id in the vocabulary (e.g. '10') or its concept URI as returned by these tools. A URI also selects its vocabulary when `vocab` is omitted. Get ids from vocab_search_concepts or vocab_suggest.");
const limitArg = z.number().int().min(1).max(200).default(50).describe("Maximum number of concepts to return (1-200, default 50)");

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

function resolve(entries: Entries, vocab: string | undefined): { instance: VocabularyInstance; adapter: VocabularyAdapter } {
  return createResolver(entries).resolve(vocab);
}

export class ForeignConceptUriError extends Error {
  constructor(uri: string, vocab: string) {
    super(`The concept URI "${uri}" does not belong to vocabulary "${vocab}".`);
    this.name = "ForeignConceptUriError";
  }
}

/**
 * Host (lower case) and the rest of a URL with repeated slashes in the path collapsed, without the scheme: http and https
 * forms of a concept URI name the same concept. Null if not a URL.
 */
function normalized(u: string | undefined): string | null {
  if (!u) return null;
  try {
    const url = new URL(u.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `//${url.host.toLowerCase()}${url.pathname.replace(/\/{2,}/g, "/")}${url.search}`;
  } catch {
    return null;
  }
}

/**
 * What a concept URI of a vocabulary starts with: its base URL (as a directory, so ".../en/" never matches ".../english/")
 * and, if set, its concept URI base exactly as given ("the text before the id", which may end in "?tema=").
 */
function prefixesOf(baseUrl: string, conceptUriBase?: string): string[] {
  const out: string[] = [];
  const base = normalized(baseUrl);
  if (base) out.push(base.endsWith("/") ? base : `${base}/`);
  const concept = normalized(conceptUriBase);
  if (concept) out.push(concept);
  return out;
}

const belongsTo = (uri: string, prefixes: string[]) => prefixes.some((p) => uri.startsWith(p));

/**
 * The vocabulary and local id for a concept argument. A URI picks its vocabulary when `vocab` is omitted (the known
 * vocabulary whose base URL or concept URI base is the longest prefix of it), and must belong to the chosen vocabulary;
 * otherwise a URI from elsewhere, or from another vocabulary on the same host, would silently resolve to a different
 * concept with the same id.
 */
function resolveConcept(entries: Entries, vocab: string | undefined, idOrUri: string) {
  const raw = idOrUri.trim();
  const isUri = /^https?:\/\//i.test(raw);
  const uri = isUri ? normalized(raw) : null;
  const resolver = createResolver(entries);
  let chosen = vocab;
  if (uri && !vocab) {
    let best: { id: string; length: number } | undefined;
    for (const e of resolver.registry.all()) {
      for (const p of prefixesOf(e.baseUrl, e.ext.conceptUriBase)) {
        if (uri.startsWith(p) && (!best || p.length > best.length)) best = { id: e.id, length: p.length };
      }
    }
    if (best) chosen = best.id;
  }
  const { instance, adapter } = resolver.resolve(chosen);
  if (isUri && !(uri && belongsTo(uri, prefixesOf(instance.baseUrl, instance.conceptUriBase)))) {
    throw new ForeignConceptUriError(raw, instance.id);
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

/**
 * The eight tools for a deployment's vocabularies: `entries` are the known vocabularies (ids usable as `vocab`), the
 * first is the default. Any other vocabulary is reachable by its base URL when the deployment's allow-list lets the
 * request through.
 */
export function createSkosTools(entries: Entries = []): ToolSpec<any>[] {
  const vocabArg = vocabArgBase.describe(vocabArgDescription(entries));

  const searchConcepts: ToolSpec<{ query: z.ZodString; vocab: typeof vocabArg; limit: typeof limitArg; response_format: typeof formatArg }> = {
    name: "vocab_search_concepts",
    title: "Search concepts",
    description:
      "Search a controlled vocabulary (thesaurus, SKOS concept scheme) for concepts whose preferred or alternative labels contain the query. " +
      "Use it to find the concept for a word, then call vocab_get_concept with the id for its definition and relations. " +
      "Matches on alternative labels (synonyms, other languages) say which label matched. " +
      (entries.length ? `Vocabularies here: ${listed(entries)}. When a question is about one of them, prefer this tool to memory or a web search. ` : "") +
      "Example: { query: 'data' }.",
    inputSchema: {
      query: z.string().min(2).max(200).describe("Text to look for in labels (at least two characters; case-insensitive, substring)"),
      vocab: vocabArg,
      limit: limitArg,
      response_format: formatArg
    },
    annotations: { title: "Search concepts", ...READ_ONLY },
    async handler(args, ctx) {
      const { instance, adapter } = resolve(entries, args.vocab);
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
      const { instance, adapter } = resolve(entries, args.vocab);
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
      const { instance, adapter, id } = resolveConcept(entries, args.vocab, args.id);
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
        const { instance, adapter, id } = resolveConcept(entries, args.vocab, args.id);
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
      const { instance, adapter } = resolve(entries, args.vocab);
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
      const { instance, adapter } = resolve(entries, args.vocab);
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

  return [searchConcepts, getConcept, broader, narrower, related, topConcepts, suggest, schemeInfo];
}

export { ConceptNotFoundError };
