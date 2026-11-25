/**
 * A login in front of one service of a Worker (createServicesHandler): OAuth 2.1 with PKCE, as MCP clients expect it,
 * where the person who logs in types the deployment's password on a page the Worker serves.
 *
 * Stateless: the client id (from dynamic registration), the authorization code and both tokens are signed with a key
 * derived from the deployment's signing secret, the service's id and the password, and carry their own expiry. Nothing
 * is stored, so no storage binding is needed and every isolate accepts what another one issued. Changing the password
 * or the signing secret ends every login at once. The price of statelessness: an authorization code can be redeemed
 * more than once within its two minutes (PKCE still binds it to the client that asked for it), and a refresh token
 * that has been replaced stays valid until it expires on its own.
 *
 * A refresh token lives `refreshIdleSeconds` (default 90 days) and is replaced at every refresh, so a client that is
 * used at least that often never asks the person to log in again; an access token lives `accessSeconds` (one hour).
 *
 * Uses only Web Crypto, so it runs on Workers and on Node alike.
 */

export interface LoginPageText {
  /** The page's language tag, e.g. "en". */
  lang: string;
  title: string;
  intro: string;
  password: string;
  submit: string;
  /** Shown after a wrong password. */
  wrong: string;
  /** Shown when too many passwords have been tried from the same address; the person waits a minute. */
  tooMany: string;
  /** Shown when the request to log in is broken (unknown client, a redirect address the client did not register). */
  badRequest: string;
  /** Before the host the person is sent to after logging in, e.g. "After logging in you are sent to". */
  sendsTo: string;
}

/**
 * Counts password attempts, e.g. a Workers rate limiting binding: `success` is false once a key has had its share. A
 * structural type, so the core depends on no platform's types. The address it counts by is Cloudflare's
 * `CF-Connecting-IP` header, which only Cloudflare sets: behind another platform a client could set it, so a limiter
 * there needs a host that sets the address itself.
 */
export interface AttemptLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface ServiceLogin<Env> {
  /** The password a person types to log in: at least 16 characters, or the service is off. */
  password(env: Env): string | undefined;
  /**
   * The secret everything issued is signed with: 32-256 characters of A-Z, a-z, 0-9, "_" and "-", or the service is
   * off. Generated at random and kept only as a secret of the deployment.
   */
  signingSecret(env: Env): string | undefined;
  /** The login page's text, in the language the request asks for. */
  page(request: Request): LoginPageText;
  /**
   * The hosts a client may be sent back to after logging in (e.g. "claude.ai", and "localhost" or "127.0.0.1" for a
   * command-line client); registration refuses any other. Without it any HTTPS address may be registered, and the
   * login page's naming of the host is the only check.
   */
  redirectHosts?: readonly string[];
  /**
   * Limits password attempts per client address (the `CF-Connecting-IP` header), counted before the password is
   * checked, right or wrong; a refused attempt is told to wait a minute, so the limiter's period is a minute. A login
   * that names a limiter is off (404) while the limiter is missing from the deployment, never open without it.
   * Without one the only defence against guessing is the password's length.
   */
  attemptLimiter?(env: Env): AttemptLimiter | undefined;
  /** How long an access token lives, in seconds; default 3600. */
  accessSeconds?: number;
  /** How long a refresh token lives unused, in seconds; default 90 days. Each refresh starts it over. */
  refreshIdleSeconds?: number;
}

const MIN_PASSWORD = 16;
const SIGNING_SECRET = /^[A-Za-z0-9_-]{32,256}$/;
const CODE_SECONDS = 120;
const DEFAULT_ACCESS_SECONDS = 3600;
const DEFAULT_REFRESH_IDLE_SECONDS = 90 * 24 * 3600;
const MAX_FORM = 16_384;
const MAX_PASSWORD = 1024;
const MAX_TOKEN = 16_384;
// Small enough that a client id holding all its addresses, and a code holding that id, stay under MAX_TOKEN.
const MAX_REDIRECT_URIS = 10;
const MAX_URI = 512;
const PKCE = /^[A-Za-z0-9._~-]{43,128}$/;
const MAX_STATE = 1000;

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return undefined;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

type Kind = "client" | "code" | "access" | "refresh";
type Claims = Record<string, unknown> & { t: Kind; exp?: number };

const now = () => Math.floor(Date.now() / 1000);

/** The keys of one service, derived from its secrets; undefined (the service is off) when they do not hold the rules. */
export interface LoginKeys {
  sign(claims: Claims): Promise<string>;
  /** The claims of a token of this kind, if it is signed with these keys and has not expired. */
  open(token: string | null | undefined, kind: Kind): Promise<Claims | undefined>;
  /** Whether `candidate` is the password, in time that does not depend on how much of it matches. */
  isPassword(candidate: string): Promise<boolean>;
}

export function loginConfigured<Env>(login: ServiceLogin<Env>, env: Env): boolean {
  const password = login.password(env);
  const secret = login.signingSecret(env);
  return typeof password === "string" && password.length >= MIN_PASSWORD && password.length <= MAX_PASSWORD && typeof secret === "string" && SIGNING_SECRET.test(secret);
}

export async function loginKeys<Env>(login: ServiceLogin<Env>, env: Env, serviceId: string): Promise<LoginKeys | undefined> {
  if (!loginConfigured(login, env)) return undefined;
  const password = login.password(env)!;
  const hmac = { name: "HMAC", hash: "SHA-256" } as const;
  const root = await crypto.subtle.importKey("raw", enc.encode(login.signingSecret(env)!), hmac, false, ["sign"]);
  // The password is part of the key, so a new password ends every login, as a new signing secret does.
  const derived = new Uint8Array(await crypto.subtle.sign("HMAC", root, enc.encode(`login-v1\0${serviceId}\0${password}`)));
  const key = await crypto.subtle.importKey("raw", derived, hmac, false, ["sign", "verify"]);
  const expected = await crypto.subtle.sign("HMAC", key, enc.encode(`password\0${password}`));

  return {
    async sign(claims) {
      const body = b64url(enc.encode(JSON.stringify(claims)));
      const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${claims.t}.${body}`)));
      return `${body}.${b64url(mac)}`;
    },
    async open(token, kind) {
      if (typeof token !== "string" || token.length > MAX_TOKEN) return undefined;
      const parts = token.split(".");
      if (parts.length !== 2) return undefined;
      const mac = fromB64url(parts[1]);
      if (!mac || !(await crypto.subtle.verify("HMAC", key, mac, enc.encode(`${kind}.${parts[0]}`)))) return undefined;
      const raw = fromB64url(parts[0]);
      if (!raw) return undefined;
      let claims: unknown;
      try {
        claims = JSON.parse(dec.decode(raw));
      } catch {
        return undefined;
      }
      if (!claims || typeof claims !== "object" || (claims as Claims).t !== kind) return undefined;
      const exp = (claims as Claims).exp;
      if (exp !== undefined && (typeof exp !== "number" || exp <= now())) return undefined;
      return claims as Claims;
    },
    async isPassword(candidate) {
      if (candidate.length > MAX_PASSWORD) return false;
      return crypto.subtle.verify("HMAC", key, expected, enc.encode(`password\0${candidate}`));
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Endpoints

const CORS = { "Access-Control-Allow-Origin": "*" };
const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" };

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS, ...NO_STORE, ...extra } });
const oauthError = (error: string, status = 400) => json({ error }, status);

/** The addresses of one service's login, from the request's origin and the service's path segment. */
export interface LoginUrls {
  issuer: string;
  resource: string;
  resourceMetadata: string;
}

export function loginUrls(request: Request, segment: string): LoginUrls {
  const origin = new URL(request.url).origin;
  return {
    issuer: `${origin}/${segment}`,
    resource: `${origin}/${segment}/mcp`,
    resourceMetadata: `${origin}/.well-known/oauth-protected-resource/${segment}/mcp`
  };
}

export function protectedResourceMetadata(urls: LoginUrls): Response {
  return json({ resource: urls.resource, authorization_servers: [urls.issuer], bearer_methods_supported: ["header"] });
}

export function authorizationServerMetadata(urls: LoginUrls): Response {
  return json({
    issuer: urls.issuer,
    authorization_endpoint: `${urls.issuer}/authorize`,
    token_endpoint: `${urls.issuer}/token`,
    registration_endpoint: `${urls.issuer}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true
  });
}

/** The answer to an MCP request without a valid access token: 401 with where to log in. */
export function unauthorized(urls: LoginUrls, tokenGiven: boolean): Response {
  const challenge = `Bearer resource_metadata="${urls.resourceMetadata}"${tokenGiven ? ', error="invalid_token"' : ""}`;
  return json({ error: tokenGiven ? "invalid_token" : "unauthorized" }, 401, {
    "WWW-Authenticate": challenge,
    "Access-Control-Expose-Headers": "WWW-Authenticate"
  });
}

/** Whether the request carries a valid access token for this service. */
export async function hasAccess(request: Request, keys: LoginKeys): Promise<{ ok: boolean; tokenGiven: boolean }> {
  const header = request.headers.get("authorization") ?? "";
  const m = /^Bearer ([A-Za-z0-9_.-]+)$/i.exec(header.trim());
  if (!m) return { ok: false, tokenGiven: header !== "" };
  return { ok: (await keys.open(m[1], "access")) !== undefined, tokenGiven: true };
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A redirect address a client may register: HTTPS, or HTTP to this machine (a command-line client), no fragment. */
function allowedRedirect(uri: unknown, hosts: readonly string[] | undefined): uri is string {
  if (typeof uri !== "string" || uri.length > MAX_URI) return false;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (hosts && !hosts.includes(u.hostname)) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && LOOPBACK.has(u.hostname);
}

/**
 * Whether `uri` is one of the registered addresses: exactly, or for HTTP to this machine with any port (RFC 8252,
 * section 7.3: a command-line client listens on whatever port is free).
 */
function registeredRedirect(uri: string, registered: readonly unknown[]): boolean {
  if (registered.includes(uri)) return true;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" || !LOOPBACK.has(u.hostname) || u.hash || u.username || u.password) return false;
  return registered.some((r) => {
    if (typeof r !== "string") return false;
    try {
      const v = new URL(r);
      return v.protocol === "http:" && v.hostname === u.hostname && v.pathname === u.pathname && v.search === u.search;
    } catch {
      return false;
    }
  });
}

async function readBody(request: Request): Promise<string | undefined> {
  const text = await request.text();
  return text.length > MAX_FORM ? undefined : text;
}

/** POST /<segment>/register (RFC 7591): any client may register; it still needs the password to get a token. */
export async function register(request: Request, keys: LoginKeys, hosts?: readonly string[]): Promise<Response> {
  if (request.method === "OPTIONS") return preflight();
  if (request.method !== "POST") return oauthError("invalid_request", 405);
  const text = await readBody(request);
  let body: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(text ?? "");
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    body = undefined;
  }
  const uris = body?.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS || !uris.every((u) => allowedRedirect(u, hosts))) {
    return json({ error: "invalid_redirect_uri" }, 400);
  }
  const issuedAt = now();
  // A random part, so that two registrations with the same addresses are two clients.
  const clientId = await keys.sign({ t: "client", ru: uris, iat: issuedAt, n: b64url(crypto.getRandomValues(new Uint8Array(12))) });
  return json({
    client_id: clientId,
    client_id_issued_at: issuedAt,
    redirect_uris: uris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"]
  }, 201);
}

function preflight(): Response {
  return new Response(null, {
    status: 204,
    headers: { ...CORS, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Max-Age": "86400" }
  });
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  ...NO_STORE
};

const STYLE = "body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}" +
  "input{font:inherit;width:100%;box-sizing:border-box;padding:.5rem;margin:.25rem 0 1rem}button{font:inherit;padding:.5rem 1rem}" +
  ".err{color:#a00}@media (prefers-color-scheme:dark){body{color:#eee;background:#141414}.err{color:#f88}}";

function page(text: LoginPageText, body: string, status: number): Response {
  const html = `<!doctype html><html lang="${esc(text.lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>${esc(text.title)}</title><style>${STYLE}</style></head><body><h1>${esc(text.title)}</h1>${body}</body></html>`;
  return new Response(html, { status, headers: PAGE_HEADERS });
}

/** The parameters of a request to log in, checked against the client's registration. */
interface AuthRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
}

/**
 * The request to log in, or undefined. Any fault is shown on our own page, never sent back to the client's address:
 * registration is open to anyone, so a registered address is not a trusted one, and redirecting an error there without
 * a password would make this host an open redirector.
 */
async function checkAuthRequest(params: URLSearchParams, keys: LoginKeys): Promise<AuthRequest | undefined> {
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const client = await keys.open(clientId, "client");
  const registered = Array.isArray(client?.ru) ? (client.ru as unknown[]) : [];
  if (!client || !registeredRedirect(redirectUri, registered)) return undefined;
  const state = params.get("state") ?? undefined;
  const challenge = params.get("code_challenge") ?? "";
  if (params.get("response_type") !== "code" || !PKCE.test(challenge) || params.get("code_challenge_method") !== "S256") return undefined;
  if (state !== undefined && state.length > MAX_STATE) return undefined;
  return { clientId, redirectUri, codeChallenge: challenge, ...(state !== undefined ? { state } : {}) };
}

function loginForm(text: LoginPageText, req: AuthRequest, wrong: boolean): string {
  const hidden: [string, string][] = [
    ["response_type", "code"], ["client_id", req.clientId], ["redirect_uri", req.redirectUri],
    ["code_challenge", req.codeChallenge], ["code_challenge_method", "S256"], ...(req.state !== undefined ? [["state", req.state] as [string, string]] : [])
  ];
  // The host the code goes to, in plain sight: a link from someone else may name their own address.
  const host = new URL(req.redirectUri).host;
  return `<p>${esc(text.intro)}</p><p>${esc(text.sendsTo)} <strong id="sends-to">${esc(host)}</strong>.</p>${wrong ? `<p class="err" role="alert">${esc(text.wrong)}</p>` : ""}<form method="post">` +
    hidden.map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join("") +
    `<label for="pw">${esc(text.password)}</label><input id="pw" type="password" name="password" autocomplete="current-password" required autofocus>` +
    `<button type="submit">${esc(text.submit)}</button></form>`;
}

/** GET shows the login page, POST checks the password and sends the person back to the client with a code. */
export async function authorize(request: Request, keys: LoginKeys, text: LoginPageText, issuer: string, limiter?: AttemptLimiter, serviceId = ""): Promise<Response> {
  const redirect = (to: string) => new Response(null, { status: 302, headers: { Location: to, ...NO_STORE, "Referrer-Policy": "no-referrer" } });
  const broken = () => page(text, `<p class="err">${esc(text.badRequest)}</p>`, 400);
  if (request.method === "GET") {
    const req = await checkAuthRequest(new URL(request.url).searchParams, keys);
    return req ? page(text, loginForm(text, req, false), 200) : broken();
  }
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, POST" } });
  const body = await readBody(request);
  const form = new URLSearchParams(body ?? "");
  const req = body === undefined ? undefined : await checkAuthRequest(form, keys);
  if (!req) return broken();
  // Counted before the check, so a guess costs a share whether it is right or not. A limiter that throws is an error,
  // never a way past the limit; one that wrongly says yes is not caught here, so the limit is tried live.
  if (limiter) {
    const address = request.headers.get("CF-Connecting-IP") ?? "unknown";
    // Printable characters only, the safer form for a key. A service id has no ":", so the key stays unambiguous with
    // an IPv6 address after it. How exactly a deployed limiter counts: docs/DECISIONS.md, 2026-11-24.
    if (!(await limiter.limit({ key: `${serviceId}:${address}` })).success) {
      // The form again, so the person can try once the minute has passed.
      const r = page(text, `<p class="err" role="alert">${esc(text.tooMany)}</p>${loginForm(text, req, false)}`, 429);
      r.headers.set("Retry-After", "60");
      return r;
    }
  }
  if (!(await keys.isPassword(form.get("password") ?? ""))) return page(text, loginForm(text, req, true), 401);
  const code = await keys.sign({ t: "code", cid: req.clientId, ru: req.redirectUri, cc: req.codeChallenge, exp: now() + CODE_SECONDS });
  const back = new URL(req.redirectUri);
  back.searchParams.set("code", code);
  if (req.state !== undefined) back.searchParams.set("state", req.state);
  back.searchParams.set("iss", issuer);
  return redirect(back.toString());
}

async function s256(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier))));
}

/** The client id from the form, or from HTTP Basic authentication if the client sends it there. */
function clientIdOf(request: Request, form: URLSearchParams): string | undefined {
  const fromForm = form.get("client_id");
  if (fromForm) return fromForm;
  const m = /^Basic ([A-Za-z0-9+/=]+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!m) return undefined;
  try {
    const user = atob(m[1]).split(":")[0];
    return decodeURIComponent(user);
  } catch {
    return undefined;
  }
}

/** POST /<segment>/token: an authorization code or a refresh token for a new access token and a new refresh token. */
export async function token<Env>(request: Request, keys: LoginKeys, login: ServiceLogin<Env>): Promise<Response> {
  if (request.method === "OPTIONS") return preflight();
  if (request.method !== "POST") return oauthError("invalid_request", 405);
  const body = await readBody(request);
  if (body === undefined) return oauthError("invalid_request");
  const form = new URLSearchParams(body);
  const clientId = clientIdOf(request, form);
  if (!clientId || !(await keys.open(clientId, "client"))) return oauthError("invalid_client", 401);

  const grant = form.get("grant_type");
  if (grant === "authorization_code") {
    const code = await keys.open(form.get("code"), "code");
    const verifier = form.get("code_verifier") ?? "";
    if (!code || code.cid !== clientId || (form.has("redirect_uri") && code.ru !== form.get("redirect_uri")) || !PKCE.test(verifier) || (await s256(verifier)) !== code.cc) {
      return oauthError("invalid_grant");
    }
  } else if (grant === "refresh_token") {
    const refresh = await keys.open(form.get("refresh_token"), "refresh");
    if (!refresh || refresh.cid !== clientId) return oauthError("invalid_grant");
  } else {
    return oauthError("unsupported_grant_type");
  }

  const accessSeconds = login.accessSeconds ?? DEFAULT_ACCESS_SECONDS;
  const t = now();
  return json({
    access_token: await keys.sign({ t: "access", cid: clientId, exp: t + accessSeconds }),
    token_type: "Bearer",
    expires_in: accessSeconds,
    refresh_token: await keys.sign({ t: "refresh", cid: clientId, exp: t + (login.refreshIdleSeconds ?? DEFAULT_REFRESH_IDLE_SECONDS) })
  });
}
