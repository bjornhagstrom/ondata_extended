/**
 * Ported in part from ondata/italianparliament-mcp src/tools/bill-signatories.ts at fd46810 (MIT, see
 * NOTICE.md): only its two pure exported helpers, lines 94-119, verbatim. `cameraPhasePattern` is
 * used by bill-progress; `parseCameraActUri` comes along because the original's test of this file
 * covers both. The `bill-signatories` tool itself is not ported yet.
 */

/**
 * Numero e legislatura di un atto Camera dal suo URI
 * (`.../attocamera.rdf/ac19_2500` → leg 19, atto 2500). Le letture successive
 * hanno il suffisso col trattino, come nel repertorio Senato
 * (`ac19_976-B` → 976-B): verificato sul grafo Camera.
 */
export function parseCameraActUri(
  uri: string,
): { legislature: number; number: string } | undefined {
  const m = /\/ac(\d+)_(\d+(?:-[A-Z])?)/.exec(uri);
  if (!m) return undefined;
  return { legislature: Number(m[1]), number: m[2] };
}

/**
 * Pattern della fase Camera nel repertorio Senato per un numero d'atto.
 *
 * L'URI Camera scrive la lettura successiva attaccata (`ac19_1511B`), il
 * repertorio Senato la scrive col trattino (`1511-B`): un confronto esatto sul
 * numero così com'è non lega nulla e l'origine resterebbe non trovata. Si cerca
 * quindi sul numero base accettando il suffisso — le letture dello stesso DDL
 * condividono comunque l'`osr:idDdl`, che è ciò che serve.
 */
export function cameraPhasePattern(number: string): string {
  return `${number.replace(/-?[A-Z]$/, "")}(-[A-Z])?`;
}
