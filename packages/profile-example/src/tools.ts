/**
 * The two tools. One of each kind the contract offers:
 *  - `akn_list_files` returns rows; the host formats them (MCP: a table; a CLI: CSV or JSONL);
 *  - `akn_document` returns a finished result (Markdown or JSON).
 *
 * Every request goes through `ctx.http`: the core applies the SSRF guards, the size cap, the
 * timeout, the rate limit and this profile's host policies. The profile never calls `fetch`.
 */

import { z } from "zod";
import { HttpStatusError } from "@ondata-extended/core";
import type { EngineContext, FetchOptions, Row, ToolSpec } from "@ondata-extended/profile-contract";
import { FILE_NAME, KIND_TITLES, KINDS, LISTING_CAP, fileUrl, isListing, listingUrl, summarize, type Kind } from "./akn.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const legislatureArg = z.number().int().min(13).max(19).describe("Senate legislature, 13-19 (19 is the current one)");
const ddlArg = z.number().int().min(1).max(99_999_999)
  .describe("The bill's id in the Senate's linked data: the number in http://dati.senato.it/ddl/<id> (e.g. 60233). Not the bill number shown as 'S.1944'.");
const kindArg = z.enum(KINDS)
  .describe(`Document folder: ${KINDS.map((k) => `'${k}' (${KIND_TITLES[k]})`).join(", ")}`);

/** The source changes at most hourly; listings and files are cached for that long. */
const CACHE = { ttlSeconds: 3600 };

/** The request options this profile uses: its upstreams are constants, not caller URLs. */
function options(): FetchOptions {
  return { fixedUpstream: true, userAgent: "honest", cache: CACHE };
}

/**
 * GitHub's anonymous limit is 60 requests an hour per IP address, which a shared Worker IP can
 * exhaust. A token (`<PREFIX>_GITHUB_TOKEN`, read through the core config) raises it. The token
 * goes only to api.github.com and never into a message, a log line or telemetry.
 */
function apiHeaders(ctx: EngineContext): HeadersInit {
  const token = ctx.config.get("GITHUB_TOKEN");
  return {
    Accept: "application/vnd.github+json",
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

export class NotInRepositoryError extends Error {
  constructor(what: string) {
    super(`${what} is not in the Senate's Akoma Ntoso repository.`);
    this.name = "NotInRepositoryError";
  }
}

const listFilesShape = {
  legislature: legislatureArg,
  ddl: ddlArg,
  kind: kindArg.optional().describe("Document folder; omit to see which folders the bill has")
};

const listFiles: ToolSpec<typeof listFilesShape> = {
  name: "akn_list_files",
  title: "List a Senate bill's Akoma Ntoso files",
  description:
    "List the Akoma Ntoso XML files the Italian Senate publishes for one bill (texts, amendments, reports), " +
    "from its bulk data on GitHub. Without `kind`, lists the bill's document folders. Use a file name with akn_document.",
  examples: ['{ "legislature": 19, "ddl": 60233 }', '{ "legislature": 19, "ddl": 60233, "kind": "sommcomm" }'],
  inputSchema: listFilesShape,
  annotations: { title: "List Akoma Ntoso files", ...READ_ONLY },
  async rows({ legislature, ddl, kind }, ctx) {
    const url = listingUrl(legislature, ddl, kind as Kind | undefined);
    let listing: unknown;
    try {
      listing = await ctx.http.json(url, { headers: apiHeaders(ctx) }, options());
    } catch (error) {
      if (error instanceof HttpStatusError && error.status === 404) {
        throw new NotInRepositoryError(kind ? `Folder ${kind} of ddl ${ddl} (legislature ${legislature})` : `Ddl ${ddl} (legislature ${legislature})`);
      }
      throw error;
    }
    if (!isListing(listing)) throw new Error("GitHub did not answer with a folder listing.");
    const rows: Row[] = listing.map((e) => ({
      name: e.name,
      type: e.type,
      size: e.type === "file" && typeof e.size === "number" ? String(e.size) : "",
      ...(kind ? {} : { title: e.type === "dir" && e.name in KIND_TITLES ? KIND_TITLES[e.name as Kind] : "" })
    }));
    ctx.telemetry.note({ result_count: rows.length });
    return {
      rows,
      columns: kind ? ["name", "type", "size"] : ["name", "type", "title"],
      ...(listing.length >= LISTING_CAP ? { notice: `GitHub lists at most ${LISTING_CAP} entries per folder; this folder may have more.` } : {}),
      emptyText: "The folder is empty. Do not assume documents exist that are not listed."
    };
  }
};

const documentShape = {
  legislature: legislatureArg,
  ddl: ddlArg,
  kind: kindArg,
  file: z.string().regex(FILE_NAME).describe("File name from akn_list_files, e.g. '01511402-em.akn.xml'"),
  max_chars: z.number().int().min(200).max(20_000).default(4000).describe("Characters of the document's text to return (200-20000, default 4000)"),
  response_format: z.enum(["markdown", "json"]).default("markdown").describe("Output format: 'markdown' for reading, 'json' for programs")
};

const document: ToolSpec<typeof documentShape> = {
  name: "akn_document",
  title: "Read a Senate Akoma Ntoso document",
  description:
    "Read one Akoma Ntoso file of the Italian Senate: its type, number and date, and its text without markup " +
    "(an amendment, a bill text, a report). Get file names from akn_list_files.",
  examples: ['{ "legislature": 19, "ddl": 60233, "kind": "emendc", "file": "01511402-em.akn.xml" }'],
  inputSchema: documentShape,
  annotations: { title: "Read an Akoma Ntoso document", ...READ_ONLY },
  async handler({ legislature, ddl, kind, file, max_chars, response_format }, ctx) {
    const url = fileUrl(legislature, ddl, kind, file);
    const res = await ctx.http.request(url, {}, options());
    if (res.status === 404) throw new NotInRepositoryError(`File ${kind}/${file} of ddl ${ddl} (legislature ${legislature})`);
    if (res.status < 200 || res.status > 299) throw new HttpStatusError(res.status, res.statusText, url, null);
    if (res.text === null) throw new Error("The file could not be read as text.");

    const doc = summarize(res.text);
    const truncated = doc.text.length > max_chars;
    // Cut on a code point, not inside a surrogate pair.
    const cut = truncated && /[\uD800-\uDBFF]/.test(doc.text[max_chars - 1]) ? max_chars - 1 : max_chars;
    const text = truncated ? `${doc.text.slice(0, cut)}…` : doc.text;
    const o = ctx.output;

    if (response_format === "json") {
      return o.json({
        legislature, ddl, kind, file, url,
        name: doc.name ?? null, subtype: doc.subtype ?? null, number: doc.number ?? null,
        date: doc.date ?? null, date_name: doc.dateName ?? null,
        text, text_length: doc.text.length, truncated
      });
    }
    const heading = [doc.name, doc.number].filter(Boolean).map((v) => o.sanitizeInline(v)).join(" ") || o.sanitizeInline(file);
    let md = `# ${heading}\n\n`;
    if (doc.subtype) md += `- **Type**: ${o.sanitizeInline(doc.subtype)}\n`;
    if (doc.date) md += `- **Date**: ${o.sanitizeInline(doc.date)}${doc.dateName ? ` (${o.sanitizeInline(doc.dateName)})` : ""}\n`;
    md += `- **Bill**: ddl ${ddl}, legislature ${legislature}, ${KIND_TITLES[kind]}\n`;
    md += `- **Source**: ${o.safeUrlText(url)}\n`;
    md += `- **Text**: ${truncated ? `first ${max_chars} of ${doc.text.length} characters (raise max_chars for more)` : `${doc.text.length} characters`}\n\n`;
    md += o.wrapUntrusted(text);
    return o.text(md);
  }
};

export const EXAMPLE_TOOLS: ToolSpec<any>[] = [listFiles, document];
