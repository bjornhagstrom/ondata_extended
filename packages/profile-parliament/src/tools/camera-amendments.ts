/**
 * Ported from ondata/italianparliament-mcp src/tools/camera-amendments.ts at fd46810 (MIT, see NOTICE.md).
 *
 * Reach changed, behaviour kept:
 * - `fetchHtml` sends through the engine's HTTP client (`ctx.http`: SSRF guards, size cap, a
 *   timeout that also covers the body, at most 5 redirects each re-validated) instead of the
 *   global `fetch`. Same URL, method and headers (`User-Agent`, `Accept`, `Accept-Language`); no
 *   retry and no throttle, as in the original (no host policy for these hosts). A transport
 *   failure reads `fetch failed`, the text the original's `fetch` gave on Node; a refusal of the
 *   core's guards and a timeout read the core's text (deviation P8 in docs/parliament-port.md).
 * - The scheda and the ostr index are the tool's own constant upstream (`fixedUpstream`: the
 *   deployment's domain allowlist does not apply to their first hop); a list URL taken from a
 *   page is too when it is on documenti.camera.it, and is checked against the allowlist otherwise.
 * - `execute` takes the engine context and passes it to `fetchHtml`.
 * Parsing is the original's: `cheerio/slim` (same version range, ^1.2.0), same selectors.
 */

import { z } from "zod";
// cheerio/slim: stesso parser (htmlparser2) e selettori, ma SENZA encoding-sniffer
// (iconv-lite → require dinamico di "buffer" che rompe il bundle ESM e gonfia il
// Worker). Le pagine sono UTF-8 e vengono già decodificate da res.text().
import * as cheerio from "cheerio/slim";
import type { EngineContext } from "@ondata-extended/profile-contract";
import { TransportError } from "@ondata-extended/core";
import { actHtmlUrl, parseCameraActUri } from "../core/html-url.js";
import { DEFAULT_TIMEOUT_MS } from "../core/endpoints.js";
import type { Tool } from "./types.js";

// Gli emendamenti della Camera NON esistono nel LOD OCD (a differenza del
// Senato, osr:Emendamento). Sono però pubblicati dall'app HTML
// `getProposteEmendative.aspx`, per singolo atto e per sede (referente /
// Assemblea), con articolo, numero, primo firmatario ed esito. Questo tool
// li recupera via scraping (cheerio): la fonte è HTML, non dati aperti, quindi
// dipende dalla struttura delle pagine — i test-sentinella fissano i conteggi
// noti per accorgersi di eventuali cambi di markup.

const EME_BASE = "https://documenti.camera.it/apps/emendamenti/";
const UA = "Mozilla/5.0 (italianparliament-mcp; +https://github.com/ondata/italianparliament-mcp)";

const inputSchema = z.object({
  billUri: z
    .string()
    .url()
    .describe(
      "URI dell'atto Camera (es. http://dati.camera.it/ocd/attocamera.rdf/ac19_2696). Ottenibile da bill-progress/bills.",
    ),
  countOnly: z
    .boolean()
    .default(false)
    .describe("Restituisce solo il conteggio degli emendamenti per sede (referente/Assemblea)."),
  limit: z.number().int().min(1).max(5000).default(2000),
});

// Nota: l'esito (approvato/respinto/ritirato) NON è nelle liste cumulative
// "in ordine di pubblicazione" (cella vuota); vive nella vista per-seduta
// (getProposteEmendativeSeduta). Estrarlo è un possibile Phase 2, non incluso
// qui per non esporre una colonna sistematicamente vuota.
const columns = [
  "sede",
  "article",
  "number",
  "first_signatory",
  "person_id",
  "identical",
  "text_url",
];
const countColumns = ["sede", "count", "list_url"];

/** Hosts this tool reads by construction (the scheda atto and the emendamenti app). */
const FIXED_HOSTS = new Set(["www.camera.it", "documenti.camera.it"]);
const onFixedHost = (url: string): boolean => URL.canParse(url) && FIXED_HOSTS.has(new URL(url).hostname);

async function fetchHtml(ctx: EngineContext, url: string): Promise<string> {
  let res;
  try {
    res = await ctx.http.request(
      url,
      {
        method: "GET",
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "it-IT,it;q=0.9,en;q=0.8",
        },
      },
      {
        userAgent: { fixed: UA },
        // The original's fetch had no timeout; the core needs one: the profile's longest (60 s).
        timeoutMs: DEFAULT_TIMEOUT_MS,
        retry: { attempts: 1 },
        ...(onFixedHost(url) ? { fixedUpstream: true } : {}),
      },
    );
  } catch (err) {
    // What the original's fetch threw on Node for a connection that failed (DNS, socket).
    if (err instanceof TransportError && (err.kind === "network" || err.kind === "not-found")) {
      throw new TypeError("fetch failed");
    }
    throw err;
  }
  if (res.status < 200 || res.status > 299) {
    throw new Error(`Recupero fallito (${res.status}) su ${url}`);
  }
  return res.text ?? "";
}

// Etichetta della sede a partire dall'URL della lista emendamenti.
function sedeLabel(url: string): string {
  const s = url.match(/sedeEsame=([^&]+)/)?.[1];
  if (s && s !== "null") return decodeURIComponent(s);
  if (/:ass:/.test(url)) return "assemblea";
  return "n.d.";
}

// Righe emendamento di una singola pagina getProposteEmendative.
function parseList(html: string, sede: string): Record<string, string>[] {
  const $ = cheerio.load(html);
  const rows: Record<string, string>[] = [];
  let article = "";
  $("tr").each((_, tr) => {
    const $tr = $(tr);
    const cls = $tr.attr("class") ?? "";
    const id = $tr.attr("id") ?? "";
    // Intestazione articolo: <tr class="rigaArticolo..." id="cmd.art..<ART>.<n>">
    if (cls.includes("rigaArticolo")) {
      const m = id.match(/cmd\.art\.\.(\d+)\./);
      if (m) article = m[1];
      return;
    }
    // Riga emendamento: <tr class="normale" id="tr.id....">
    if (!id.startsWith("tr.id.")) return;
    const numLink = $tr.find('a[href*="idPropostaEmendativa="]').first();
    const number = numLink.text().trim().replace(/\.$/, "");
    let textUrl = (numLink.attr("href") ?? "").replace(/\s+/g, "");
    if (textUrl && !/^https?:/.test(textUrl)) textUrl = EME_BASE + textUrl;
    const sig = $tr.find('a[href*="idPersona="]').first();
    const firstSignatory = sig.text().trim();
    const personId = (sig.attr("href") ?? "").match(/idPersona=(\d+)/)?.[1] ?? "";
    const identical = $tr
      .find(".emendamentiIdentici")
      .text()
      .replace(/\s+/g, " ")
      .replace(/\(\s*ident\.\s*/i, "(ident. ")
      .replace(/\s+\)/g, ")")
      .trim();
    rows.push({
      sede,
      article,
      number,
      first_signatory: firstSignatory,
      person_id: personId,
      identical,
      text_url: textUrl,
    });
  });
  return rows;
}

// Link distinti alle liste emendamenti (per sede) presenti nella scheda atto.
// Filtra getProposteEmendative.aspx (lista cumulativa), NON ...Seduta.
function schedaListUrls(html: string): string[] {
  const $ = cheerio.load(html);
  const urls = new Set<string>();
  $('a[href*="getProposteEmendative.aspx"]').each((_, a) => {
    let href = ($(a).attr("href") ?? "").replace(/\s+/g, "");
    if (!href) return;
    if (!/^https?:/.test(href)) href = EME_BASE + href;
    urls.add(href);
  });
  return [...urls];
}

export const cameraAmendmentsTool: Tool<typeof inputSchema> = {
  name: "camera-amendments",
  title: "Emendamenti (Camera)",
  description:
    "[CAMERA] Emendamenti (proposte emendative) a un atto della Camera, per sede (referente/Assemblea): numero, articolo, primo firmatario, emendamenti identici e link al testo. Con --count-only restituisce il conteggio per sede. FONTE: app HTML documenti.camera.it (gli emendamenti Camera non sono nel LOD); per il Senato usare invece 'amendments'. Copre anche gli atti di legislature passate (es. leg.18): la scheda atto storica spesso non incorpora più il link diretto agli emendamenti, in quel caso il tool usa in automatico l'indice per-atto apps/emendamenti/ostr.",
  inputSchema,
  examples: [
    "italianparliament camera-amendments list --bill-uri http://dati.camera.it/ocd/attocamera.rdf/ac19_2696 --count-only",
    "italianparliament camera-amendments list --bill-uri http://dati.camera.it/ocd/attocamera.rdf/ac19_2696 --format jsonl",
  ],
  async execute(input, ctx) {
    // Gli atti variante (ac19_703-B, la lettura successiva della navetta) sono
    // atti Camera a tutti gli effetti e hanno emendamenti propri: il vecchio
    // pattern `_(\d+)$` li rifiutava come URI non validi, rendendo gli
    // emendamenti dell'ultima lettura irraggiungibili.
    const parsed = parseCameraActUri(input.billUri);
    if (!parsed) {
      throw new Error(
        `camera-amendments richiede un URI di atto Camera ` +
          `(es. http://dati.camera.it/ocd/attocamera.rdf/ac19_2696). ` +
          `Ricevuto: "${input.billUri}". Per gli emendamenti del Senato usare il tool 'amendments'.`,
      );
    }
    const { legislature: leg, id: num } = parsed;
    const schedaUrl = actHtmlUrl(input.billUri);
    if (!schedaUrl) {
      throw new Error(`Impossibile derivare la scheda atto da "${input.billUri}".`);
    }
    const scheda = await fetchHtml(ctx, schedaUrl);
    let listUrls = schedaListUrls(scheda);

    if (listUrls.length === 0) {
      // Distinzione: scheda valida senza emendamenti (legittimo) vs pagina non
      // valida (es. blocco anti-bot che serve un 200 "diverso" ai Worker
      // Cloudflare — la fonte camera.it è raggiungibile dalla CLI locale ma non
      // sempre da datacenter). Se mancano i marcatori di una scheda atto reale,
      // è il secondo caso: fallire chiaro invece di restituire un vuoto ingannevole.
      const looksValid = /idDocumento|proposte emendativ|scheda del progetto|EMENDAMENTI/i.test(
        scheda,
      );
      if (!looksValid) {
        throw new Error(
          `Fonte Camera non raggiungibile o pagina non valida per ${schedaUrl} ` +
            `(scheda di ${scheda.length} byte senza i marcatori attesi). ` +
            `Gli emendamenti Camera si recuperano via scraping HTML: alcune reti ` +
            `(es. Worker Cloudflare) possono ricevere una risposta anti-bot. ` +
            `Riprovare dalla CLI locale.`,
        );
      }
      // Scheda valida ma senza il link diretto agli emendamenti: capita sulle
      // schede atto delle legislature vecchie (es. leg.18), che non incorporano
      // più getProposteEmendative.aspx (il bottone "Emendamenti" punta al
      // motore di ricerca generico ricerca-emendamenti) anche se gli
      // emendamenti esistono ancora alla fonte. L'indice strutturato per-atto
      // (apps/emendamenti/ostr/{leg}) li contiene comunque: fallback prima di
      // concludere "nessun emendamento".
      // Niente .catch(() => "") qui: swallowerebbe un fallimento di rete/HTTP
      // (fetchHtml lancia su !res.ok) come "nessun emendamento", lo stesso
      // problema di vuoto ingannevole appena escluso sopra per la scheda
      // principale. Se il fetch fallisce, l'errore propaga con lo status HTTP.
      const ostrUrl = `${EME_BASE}ostr/${leg}?attoportante=leg.${leg}.eme.ac.${num}`;
      const ostr = await fetchHtml(ctx, ostrUrl);
      listUrls = schedaListUrls(ostr);
    }

    if (input.countOnly) {
      const rows: Record<string, string>[] = [];
      for (const url of listUrls) {
        const sede = sedeLabel(url);
        const count = parseList(await fetchHtml(ctx, url), sede).length;
        rows.push({ sede, count: String(count), list_url: url });
      }
      return { rows, columns: countColumns };
    }

    const all: Record<string, string>[] = [];
    for (const url of listUrls) {
      all.push(...parseList(await fetchHtml(ctx, url), sedeLabel(url)));
      if (all.length >= input.limit) break;
    }
    return { rows: all.slice(0, input.limit), columns };
  },
};
