/**
 * The login in front of a service (src/login.ts through createServicesHandler): discovery, registration, the password
 * page, code and refresh grants with PKCE, a refused MCP request without a valid token, and a service that is off when
 * its login is not set up.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { z } from "zod";
import type { Profile } from "@ondata-extended/profile-contract";
import { createEngine, createMcpServer, createServicesHandler, registerProfiles, type ServiceLogin, type WorkerService } from "../src/index.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

type Env = Record<string, string | undefined>;
const PASSWORD = "correct horse battery staple";
const SIGNING = "Sg7_kd9-Lw2xP7vN4mT8rY1sB6cH0jFaQ2"; // 34 characters
const SECRET = "Zq3_kd9-Lw2xP7vN4mT8rY1sB6cH0jFa";
const ENV: Env = { PW: PASSWORD, SIGN: SIGNING, PRIV: SECRET };
const ORIGIN = "https://w.example";
const CALLBACK = "https://client.example/callback";
const VERIFIER = "v".repeat(20) + "-verifier-" + "x".repeat(20);

function profile(id: string): Profile {
  return {
    id, version: "0.0.1", toolPrefix: `${id}_`, shrinkableKeys: [], telemetryFields: ["q"], untrustedSourceLabel: id, honestUserAgent: "T/0",
    tools: [{ name: `${id}_echo`, description: "Echo", inputSchema: { q: z.string() }, handler: async (args, ctx) => ctx.output.text(`${id} ${args.q}`) }]
  };
}

const login: ServiceLogin<Env> = {
  password: (env) => env.PW,
  signingSecret: (env) => env.SIGN,
  page: () => ({ lang: "en", title: "Log in", intro: "Type the password.", password: "Password", submit: "Log in", wrong: "Wrong password.", tooMany: "Too many attempts.", badRequest: "Broken request.", sendsTo: "After logging in you are sent to" })
};

function service(id: string, where: { path: string } | { secretPath: (env: Env) => string | undefined }, withLogin = true): WorkerService<Env> {
  const engine = createEngine({ configPrefixes: [id.toUpperCase()], configSource: {}, cacheOrigin: `https://${id}.internal` });
  return {
    id, ...where, ...(withLogin ? { login } : {}),
    buildServer: () => { const s = createMcpServer({ name: id, version: "0" }); registerProfiles(s, [profile(id)], engine); return s; },
    health: () => ({ status: "ok", name: id })
  };
}

const handler = () => createServicesHandler<Env>({
  services: [service("open", { path: "open" }, false), service("guarded", { path: "guarded" }), service("hidden", { secretPath: (env) => env.PRIV })]
});

const LIST = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
const mcp = (path: string, token?: string) => new Request(`${ORIGIN}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(LIST)
});
const form = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) => new Request(`${ORIGIN}${path}`, {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString()
});

async function s256(v: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)));
  return btoa(String.fromCharCode(...d)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function registerClient(h: ReturnType<typeof handler>, seg = "guarded", uris = [CALLBACK]): Promise<string> {
  const res = await h.fetch(new Request(`${ORIGIN}/${seg}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: uris, client_name: "Test" }) }), ENV);
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

async function authParams(clientId: string, extra: Record<string, string> = {}): Promise<Record<string, string>> {
  return { response_type: "code", client_id: clientId, redirect_uri: CALLBACK, code_challenge: await s256(VERIFIER), code_challenge_method: "S256", state: "st<1>", ...extra };
}

async function logIn(h: ReturnType<typeof handler>, seg = "guarded"): Promise<{ clientId: string; code: string }> {
  const clientId = await registerClient(h, seg);
  const res = await h.fetch(form(`/${seg}/authorize`, { ...(await authParams(clientId)), password: PASSWORD }), ENV);
  expect(res.status).toBe(302);
  const back = new URL(res.headers.get("location")!);
  expect(`${back.origin}${back.pathname}`).toBe(CALLBACK);
  expect(back.searchParams.get("state")).toBe("st<1>");
  expect(back.searchParams.get("iss")).toBe(`${ORIGIN}/${seg}`);
  return { clientId, code: back.searchParams.get("code")! };
}

async function tokens(h: ReturnType<typeof handler>, fields: Record<string, string>, seg = "guarded") {
  const res = await h.fetch(form(`/${seg}/token`, fields), ENV);
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, res };
}

const listed = async (res: Response) => ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);

describe("a service behind a login", () => {
  it("refuses /mcp without a token with 401 and where to log in; a service without a login is unaffected", async () => {
    const h = handler();
    const res = await h.fetch(mcp("/guarded/mcp"), ENV);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/guarded/mcp"`);
    expect(res.headers.get("access-control-expose-headers")).toContain("WWW-Authenticate");
    expect(await listed(await h.fetch(mcp("/open/mcp"), ENV))).toEqual(["open_echo"]);
    // A service without a login has no login endpoints.
    expect((await h.fetch(form("/open/token", {}), ENV)).status).toBe(404);
    expect((await h.fetch(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/open/mcp`), ENV)).status).toBe(404);
  });

  it("lets the CORS preflight through without a token", async () => {
    const res = await handler().fetch(new Request(`${ORIGIN}/guarded/mcp`, { method: "OPTIONS" }), ENV);
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toContain("Authorization");
  });

  it("publishes the discovery documents at the RFC 9728 and RFC 8414 addresses", async () => {
    const h = handler();
    const prm = await (await h.fetch(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/guarded/mcp`), ENV)).json();
    expect(prm).toMatchObject({ resource: `${ORIGIN}/guarded/mcp`, authorization_servers: [`${ORIGIN}/guarded`] });
    for (const doc of ["oauth-authorization-server", "openid-configuration"]) {
      const meta = (await (await h.fetch(new Request(`${ORIGIN}/.well-known/${doc}/guarded`), ENV)).json()) as Record<string, unknown>;
      expect(meta).toMatchObject({
        issuer: `${ORIGIN}/guarded`, authorization_endpoint: `${ORIGIN}/guarded/authorize`, token_endpoint: `${ORIGIN}/guarded/token`,
        registration_endpoint: `${ORIGIN}/guarded/register`, code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"]
      });
    }
    expect((await h.fetch(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/guarded`), ENV)).status).toBe(404);
    expect((await h.fetch(new Request(`${ORIGIN}/.well-known/oauth-authorization-server/guarded/mcp`), ENV)).status).toBe(404);
  });

  it("runs the whole flow: register, log in with the password, code for tokens, tokens for the tools, refresh for new ones", async () => {
    const h = handler();
    const { clientId, code } = await logIn(h);
    const first = await tokens(h, { grant_type: "authorization_code", code, redirect_uri: CALLBACK, client_id: clientId, code_verifier: VERIFIER });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    expect(first.res.headers.get("cache-control")).toBe("no-store");
    expect(await listed(await h.fetch(mcp("/guarded/mcp", first.body.access_token as string), ENV))).toEqual(["guarded_echo"]);

    const second = await tokens(h, { grant_type: "refresh_token", refresh_token: first.body.refresh_token as string, client_id: clientId });
    expect(second.status).toBe(200);
    expect(await listed(await h.fetch(mcp("/guarded/mcp", second.body.access_token as string), ENV))).toEqual(["guarded_echo"]);
  });

  it("keeps a client that is used logged in: each refresh starts the 90 days over, 90 days unused ends it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const h = handler();
    const { clientId, code } = await logIn(h);
    let refresh = (await tokens(h, { grant_type: "authorization_code", code, redirect_uri: CALLBACK, client_id: clientId, code_verifier: VERIFIER })).body.refresh_token as string;
    // Used every 80 days for a year: never asked to log in again.
    for (let i = 1; i <= 5; i++) {
      vi.setSystemTime(new Date(Date.parse("2026-01-01T00:00:00Z") + i * 80 * 86_400_000));
      const next = await tokens(h, { grant_type: "refresh_token", refresh_token: refresh, client_id: clientId });
      expect(next.status, `refresh ${i}`).toBe(200);
      refresh = next.body.refresh_token as string;
    }
    // An access token lasts an hour.
    const access = (await tokens(h, { grant_type: "refresh_token", refresh_token: refresh, client_id: clientId })).body.access_token as string;
    vi.setSystemTime(Date.now() + 3601_000);
    expect((await h.fetch(mcp("/guarded/mcp", access), ENV)).status).toBe(401);
    // 91 days unused: the refresh token has expired.
    vi.setSystemTime(Date.now() + 91 * 86_400_000);
    expect((await tokens(h, { grant_type: "refresh_token", refresh_token: refresh, client_id: clientId })).body).toEqual({ error: "invalid_grant" });
  });

  it("refuses a wrong password with the page again, and no code", async () => {
    const h = handler();
    const clientId = await registerClient(h);
    const res = await h.fetch(form("/guarded/authorize", { ...(await authParams(clientId)), password: `${PASSWORD}x` }), ENV);
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    const html = await res.text();
    expect(html).toContain("Wrong password.");
    expect(html).not.toContain(PASSWORD);
  });

  it("limits password attempts per service and client address, counting right and wrong ones, before the check", async () => {
    const keys: string[] = [];
    let allowed = 2;
    const limiter = { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: allowed-- > 0 }; } };
    const limited: WorkerService<Env> = { ...service("guarded", { path: "guarded" }), login: { ...login, attemptLimiter: () => limiter } };
    const h = createServicesHandler<Env>({ services: [limited] });
    const clientId = await registerClient(h);
    const attempt = async (password: string) => h.fetch(form("/guarded/authorize", { ...(await authParams(clientId)), password }, { "CF-Connecting-IP": "203.0.113.7" }), ENV);
    expect((await attempt(`${PASSWORD}x`)).status).toBe(401);
    expect((await attempt(PASSWORD)).status).toBe(302);
    // Over the limit even the right password gets no code.
    const over = await attempt(PASSWORD);
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBe("60");
    expect(over.headers.get("location")).toBeNull();
    const overPage = await over.text();
    expect(overPage).toContain("Too many attempts.");
    expect(overPage).toContain('name="password"');
    expect(keys).toEqual(Array(3).fill("guarded\u0000203.0.113.7"));
    // Without the platform's address header all such attempts share one count.
    await h.fetch(form("/guarded/authorize", { ...(await authParams(clientId)), password: PASSWORD }), ENV);
    expect(keys.at(-1)).toBe("guarded\u0000unknown");
    keys.pop();
    // Showing the page and a broken request are not attempts.
    await h.fetch(new Request(`${ORIGIN}/guarded/authorize?${new URLSearchParams(await authParams(clientId))}`), ENV);
    await h.fetch(form("/guarded/authorize", { password: PASSWORD }), ENV);
    expect(keys).toHaveLength(3);
    // A limiter that fails lets nobody past it: the error leaves the handler, and the platform answers it as an error.
    const broken: WorkerService<Env> = { ...limited, login: { ...login, attemptLimiter: () => ({ limit: async () => { throw new Error("binding down"); } }) } };
    const hb = createServicesHandler<Env>({ services: [broken] });
    const cb = await registerClient(hb);
    await expect(hb.fetch(form("/guarded/authorize", { ...(await authParams(cb)), password: PASSWORD }), ENV)).rejects.toThrow("binding down");
  });

  it("is off, with one warning, when its login names an attempt limiter the deployment does not provide", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unlimited: WorkerService<Env> = { ...service("guarded", { path: "guarded" }), login: { ...login, attemptLimiter: () => undefined } };
    const h = createServicesHandler<Env>({ services: [unlimited] });
    for (const path of ["/guarded/register", "/guarded/authorize", "/guarded/mcp"]) {
      expect((await h.fetch(new Request(`${ORIGIN}${path}`, { method: "POST", body: "{}" }), ENV)).status, path).toBe(404);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("attempt limiter");
  });

  it("shows the login page with the request's parameters escaped and framing forbidden", async () => {
    const h = handler();
    const clientId = await registerClient(h);
    const res = await h.fetch(new Request(`${ORIGIN}/guarded/authorize?${new URLSearchParams(await authParams(clientId, { state: '"><script>x</script>' }))}`), ENV);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await res.text();
    expect(html).toContain('type="password"');
    expect(html).not.toContain("<script>");
  });

  it("never redirects to an address the client did not register, nor for an unknown client", async () => {
    const h = handler();
    const clientId = await registerClient(h);
    for (const params of [
      await authParams(clientId, { redirect_uri: "https://evil.example/cb" }),
      await authParams("not-a-client"),
      await authParams(`${clientId}x`)
    ]) {
      const res = await h.fetch(form("/guarded/authorize", { ...params, password: PASSWORD }), ENV);
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
      expect(await res.text()).toContain("Broken request.");
    }
  });

  it("shows a broken request on its own page and never redirects it, not even to a registered address", async () => {
    const h = handler();
    const clientId = await registerClient(h);
    for (const extra of [{ code_challenge_method: "plain" }, { code_challenge: "short" }, { response_type: "token" }, { state: "s".repeat(1001) }] as Record<string, string>[]) {
      const res = await h.fetch(new Request(`${ORIGIN}/guarded/authorize?${new URLSearchParams(await authParams(clientId, extra))}`), ENV);
      expect(res.status, JSON.stringify(extra).slice(0, 40)).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    }
  });

  it("names on the login page the host the code goes to", async () => {
    const h = handler();
    const clientId = await registerClient(h, "guarded", ["https://stranger.example/cb"]);
    const res = await h.fetch(new Request(`${ORIGIN}/guarded/authorize?${new URLSearchParams(await authParams(clientId, { redirect_uri: "https://stranger.example/cb" }))}`), ENV);
    const html = await res.text();
    expect(html).toContain('After logging in you are sent to <strong id="sends-to">stranger.example</strong>');
  });

  it("registers only the deployment's redirect hosts when it names them", async () => {
    const limited = createServicesHandler<Env>({ services: [{ ...service("guarded", { path: "guarded" }), login: { ...login, redirectHosts: ["claude.ai", "localhost"] } }] });
    const reg = (uris: string[]) => limited.fetch(new Request(`${ORIGIN}/guarded/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: uris }) }), ENV);
    expect((await reg(["https://claude.ai/api/mcp/auth_callback"])).status).toBe(201);
    expect((await reg(["http://localhost:4000/cb"])).status).toBe(201);
    expect((await reg(["https://stranger.example/cb"])).status).toBe(400);
    expect((await reg(["https://claude.ai/cb", "https://claude.ai.stranger.example/cb"])).status).toBe(400);
    expect((await reg(["http://127.0.0.1:4000/cb"])).status).toBe(400);
  });

  it("accepts a loopback address on another port than registered (RFC 8252), and nothing else that differs", async () => {
    const h = handler();
    const clientId = await registerClient(h, "guarded", ["http://127.0.0.1:4000/cb"]);
    const show = async (uri: string) => (await h.fetch(new Request(`${ORIGIN}/guarded/authorize?${new URLSearchParams(await authParams(clientId, { redirect_uri: uri }))}`), ENV)).status;
    expect(await show("http://127.0.0.1:51234/cb")).toBe(200);
    expect(await show("http://127.0.0.1:51234/other")).toBe(400);
    expect(await show("http://localhost:4000/cb")).toBe(400);
    expect(await show("https://127.0.0.1:4000/cb")).toBe(400);
  });

  it("refuses a code with the wrong verifier, redirect address or client, and an expired one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const h = handler();
    const { clientId, code } = await logIn(h);
    const other = await registerClient(h);
    const base = { grant_type: "authorization_code", code, redirect_uri: CALLBACK, client_id: clientId, code_verifier: VERIFIER };
    for (const bad of [{ code_verifier: `${VERIFIER}x` }, { redirect_uri: "https://client.example/other" }, { client_id: other }, { code: `${code}x` }]) {
      expect((await tokens(h, { ...base, ...bad })).body.error, JSON.stringify(bad).slice(0, 40)).toBe("invalid_grant");
    }
    expect((await tokens(h, { ...base, client_id: "nobody" })).status).toBe(401);
    expect((await tokens(h, { ...base, grant_type: "password" })).body.error).toBe("unsupported_grant_type");
    vi.setSystemTime(Date.now() + 121_000);
    expect((await tokens(h, base)).body.error).toBe("invalid_grant");
  });

  it("does not take one kind of token for another, nor a token of another service", async () => {
    const h = handler();
    const { clientId, code } = await logIn(h);
    const t = (await tokens(h, { grant_type: "authorization_code", code, redirect_uri: CALLBACK, client_id: clientId, code_verifier: VERIFIER })).body;
    expect((await h.fetch(mcp("/guarded/mcp", t.refresh_token as string), ENV)).status).toBe(401);
    expect((await h.fetch(mcp("/guarded/mcp", code), ENV)).status).toBe(401);
    expect((await h.fetch(mcp("/guarded/mcp", clientId), ENV)).status).toBe(401);
    expect((await tokens(h, { grant_type: "refresh_token", refresh_token: t.access_token as string, client_id: clientId })).body.error).toBe("invalid_grant");
    // The same secrets, another service: its keys differ.
    expect((await h.fetch(mcp(`/${SECRET}/mcp`, t.access_token as string), ENV)).status).toBe(401);
    expect((await h.fetch(mcp(`/${SECRET}/mcp`, `${t.access_token as string}x`), ENV)).status).toBe(401);
  });

  it("ends every login when the password or the signing secret changes", async () => {
    const h = handler();
    const { clientId, code } = await logIn(h);
    const t = (await tokens(h, { grant_type: "authorization_code", code, redirect_uri: CALLBACK, client_id: clientId, code_verifier: VERIFIER })).body;
    const access = t.access_token as string;
    expect((await h.fetch(mcp("/guarded/mcp", access), ENV)).status).toBe(200);
    expect((await h.fetch(mcp("/guarded/mcp", access), { ...ENV, PW: `${PASSWORD}!` })).status).toBe(401);
    expect((await h.fetch(mcp("/guarded/mcp", access), { ...ENV, SIGN: `${SIGNING}A` })).status).toBe(401);
  });

  it("works for a private service at its secret path, its discovery documents included", async () => {
    const h = handler();
    expect((await h.fetch(mcp(`/${SECRET}/mcp`), ENV)).status).toBe(401);
    expect((await h.fetch(new Request(`${ORIGIN}/.well-known/oauth-authorization-server/${SECRET}`), ENV)).status).toBe(200);
    expect((await h.fetch(new Request(`${ORIGIN}/.well-known/oauth-authorization-server/hidden`), ENV)).status).toBe(404);
    const { clientId, code } = await logIn(h, SECRET);
    const t = (await tokens(h, { grant_type: "authorization_code", code, redirect_uri: CALLBACK, client_id: clientId, code_verifier: VERIFIER }, SECRET)).body;
    expect(await listed(await h.fetch(mcp(`/${SECRET}/mcp`, t.access_token as string), ENV))).toEqual(["hidden_echo"]);
  });

  it("registers only HTTPS redirect addresses, or HTTP to this machine, without a fragment", async () => {
    const h = handler();
    const reg = (uris: unknown) => h.fetch(new Request(`${ORIGIN}/guarded/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: uris }) }), ENV);
    for (const ok of [["https://claude.ai/api/mcp/auth_callback"], ["http://localhost:33418/callback"], ["http://127.0.0.1:5000/cb"]]) {
      expect((await reg(ok)).status, String(ok)).toBe(201);
    }
    for (const bad of [[], ["http://client.example/cb"], ["https://client.example/cb#x"], ["javascript:alert(1)"], ["https://u:p@client.example/"], "https://x.example", Array(11).fill(CALLBACK)]) {
      expect((await reg(bad)).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("switches the service off, with one warning that names no value, when its login is not set up", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const env of [{ ...ENV, PW: "too short" }, { ...ENV, PW: undefined }, { ...ENV, SIGN: "short" }, { ...ENV, SIGN: `${SIGNING}.` }]) {
      const h = handler();
      expect((await h.fetch(mcp("/guarded/mcp"), env)).status).toBe(404);
      expect((await h.fetch(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/guarded/mcp`), env)).status).toBe(404);
      expect((await h.fetch(mcp("/open/mcp"), env)).status).toBe(200);
    }
    expect(warn).toHaveBeenCalledTimes(4); // once per handler, though each was asked twice
    const said = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(said).toContain('"guarded" is off');
    expect(said).not.toContain(SIGNING);
    expect(said).not.toContain("too short");
  });

  it("takes the client id from HTTP Basic authentication too", async () => {
    const h = handler();
    const { clientId, code } = await logIn(h);
    const res = await h.fetch(form("/guarded/token", { grant_type: "authorization_code", code, redirect_uri: CALLBACK, code_verifier: VERIFIER }, {
      authorization: `Basic ${btoa(`${encodeURIComponent(clientId)}:`)}`
    }), ENV);
    expect(res.status).toBe(200);
  });

  it("binds a refresh token to its client, and lets a client leave out redirect_uri at the token endpoint", async () => {
    const h = handler();
    const { clientId, code } = await logIn(h);
    const other = await registerClient(h);
    const t = await tokens(h, { grant_type: "authorization_code", code, client_id: clientId, code_verifier: VERIFIER });
    expect(t.status).toBe(200);
    expect((await tokens(h, { grant_type: "refresh_token", refresh_token: t.body.refresh_token as string, client_id: other })).body.error).toBe("invalid_grant");
  });

  it("answers a wrong token with invalid_token in the challenge, and keeps health open while on", async () => {
    const h = handler();
    const res = await h.fetch(mcp("/guarded/mcp", "not.valid"), ENV);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect((await h.fetch(new Request(`${ORIGIN}/guarded/health`), ENV)).status).toBe(200);
    expect((await h.fetch(new Request(`${ORIGIN}/guarded/health`), { ...ENV, PW: undefined })).status).toBe(404);
  });

  it("refuses other methods and oversized requests", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = handler();
    expect((await h.fetch(new Request(`${ORIGIN}/guarded/token`), ENV)).status).toBe(405);
    expect((await h.fetch(new Request(`${ORIGIN}/guarded/register`), ENV)).status).toBe(405);
    expect((await h.fetch(new Request(`${ORIGIN}/guarded/authorize`, { method: "PUT" }), ENV)).status).toBe(405);
    expect((await h.fetch(form("/guarded/token", { grant_type: "refresh_token", refresh_token: "x".repeat(20_000) }), ENV)).body).toBeTruthy();
    expect((await tokens(h, { grant_type: "refresh_token", refresh_token: "x".repeat(20_000) })).body.error).toBe("invalid_request");
    expect((await h.fetch(mcp("/guarded/mcp", "a".repeat(20_000)), ENV)).status).toBe(401);
    const clientId = await registerClient(h);
    const big = await h.fetch(form("/guarded/authorize", { ...(await authParams(clientId)), password: "p".repeat(2000) }), ENV);
    expect(big.status).toBe(401);
  });

  it("issues a client id it accepts, at the largest registration it allows", async () => {
    const h = handler();
    const uris = Array.from({ length: 10 }, (_, i) => `https://client.example/${String(i).padStart(2, "0")}${"p".repeat(480)}`);
    const clientId = await registerClient(h, "guarded", [...uris.slice(0, 9), CALLBACK]);
    const { status, body } = await (async () => {
      const res = await h.fetch(form("/guarded/authorize", { ...(await authParams(clientId)), password: PASSWORD }), ENV);
      const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
      return tokens(h, { grant_type: "authorization_code", code, client_id: clientId, code_verifier: VERIFIER });
    })();
    expect(status).toBe(200);
    expect((await h.fetch(mcp("/guarded/mcp", body.access_token as string), ENV)).status).toBe(200);
    const reg = await h.fetch(new Request(`${ORIGIN}/guarded/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [`https://client.example/${"p".repeat(500)}`] }) }), ENV);
    expect(reg.status).toBe(400);
  });

  it("is off with a password over 1024 characters, and a public service whose login is off is not listed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = handler();
    expect((await h.fetch(mcp("/guarded/mcp"), { ...ENV, PW: "p".repeat(1025) })).status).toBe(404);
    const health = (await (await h.fetch(new Request(`${ORIGIN}/health`), { ...ENV, PW: undefined })).json()) as { services: { id: string }[] };
    expect(health.services.map((s) => s.id)).toEqual(["open"]);
    const on = (await (await h.fetch(new Request(`${ORIGIN}/health`), ENV)).json()) as { services: { id: string }[] };
    expect(on.services.map((s) => s.id)).toEqual(["open", "guarded"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
