/**
 * IP address classification for the SSRF guards. Pure and dependency-free: it also runs
 * in Cloudflare Workers, where `node:net` is unavailable.
 *
 * Derived from ondata/ckan-mcp-server src/utils/http.ts (commit 09e8cdc), lines 441-576,
 * unchanged in behaviour.
 */

/**
 * Private-network addresses an administrator may open for one named host: loopback,
 * RFC 1918 and IPv6 unique-local. Link-local and cloud metadata (169.254.0.0/16),
 * 0.0.0.0/8, shared, multicast and reserved ranges stay blocked even for a listed host.
 */
export function isPrivateNetworkIp(v: string): boolean {
  if (v.includes(":")) {
    const w = parseIpv6(v);
    if (!w) return false;
    return (w.slice(0, 7).every((x) => x === 0) && w[7] === 1) || // ::1 loopback
      (w[0] & 0xfe00) === 0xfc00;                                  // fc00::/7 unique local
  }
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const o1 = Number(m[1]);
  const o2 = Number(m[2]);
  return o1 === 10 || o1 === 127 ||
    (o1 === 172 && o2 >= 16 && o2 <= 31) ||
    (o1 === 192 && o2 === 168);
}

/**
 * Parse an IPv6 literal into its eight 16-bit words, or null if malformed.
 * Total (never throws). Accepts every spelling of the same address (compressed, expanded,
 * upper-case, leading zeros, trailing dotted-quad) so the classifier decides on values,
 * not on how the address happened to be written.
 */
export function parseIpv6(input: string): number[] | null {
  const v = input.toLowerCase().split("%")[0]; // drop any zone id (fe80::1%eth0)
  if (v.includes(":::") || (v.match(/::/g) || []).length > 1) return null;

  const [head, tail, ...rest] = v.split("::");
  if (rest.length > 0) return null;
  const compressed = v.includes("::");

  const words: number[] = [];
  const pushGroups = (part: string): boolean => {
    if (part === "") return true;
    for (const g of part.split(":")) {
      if (g.includes(".")) {
        // trailing dotted-quad (::ffff:127.0.0.1, ::127.0.0.1)
        const m = g.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
        if (!m) return false;
        const o = m.slice(1).map(Number);
        if (o.some((n) => n > 255)) return false;
        words.push((o[0] << 8) | o[1], (o[2] << 8) | o[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(g)) return false;
      words.push(parseInt(g, 16));
    }
    return true;
  };

  if (!pushGroups(head)) return null;
  const headLen = words.length;
  if (!pushGroups(compressed ? tail : "")) return null;
  const tailLen = words.length - headLen;

  if (!compressed) return words.length === 8 ? words : null;
  const gap = 8 - headLen - tailLen;
  if (gap < 1) return null;
  return [...words.slice(0, headLen), ...Array(gap).fill(0), ...words.slice(headLen)];
}

/**
 * True if an IP address (IPv4 or IPv6 string) is in a private/internal/special range.
 * Shared by the literal guard and the DNS-resolution guards, so a hostname that
 * *resolves* to an internal address is blocked, not just an internal IP literal.
 *
 * IPv6 is parsed into words before classification: several IPv6 ranges embed an IPv4
 * address (NAT64, 6to4, IPv4-compatible), so `64:ff9b::a9fe:a9fe` is the cloud metadata
 * endpoint written in IPv6 and is blocked exactly like 169.254.169.254 (GHSA-x32r).
 */
export function isBlockedIp(ip: string, allowPrivate = false): boolean {
  const v = ip.toLowerCase().trim();
  if (allowPrivate && isPrivateNetworkIp(v)) return false;

  if (v.includes(":")) {
    const w = parseIpv6(v);
    if (!w) return true; // unparseable: fail closed
    const zeros = (n: number) => w.slice(0, n).every((x) => x === 0);
    return (
      zeros(6) ||                                  // ::/96 unspecified, loopback, IPv4-compatible
      (zeros(5) && w[5] === 0xffff) ||             // ::ffff:0:0/96 IPv4-mapped
      (w[0] === 0x0064 && w[1] === 0xff9b &&
        ((w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0) ||
          w[2] === 0x0001)) ||                     // 64:ff9b::/96 + 64:ff9b:1::/48 NAT64
      w[0] === 0x2002 ||                           // 2002::/16 6to4
      (w[0] === 0x2001 && w[1] === 0x0000) ||      // 2001::/32 Teredo
      (w[0] & 0xfe00) === 0xfc00 ||                // fc00::/7 unique local
      (w[0] & 0xffc0) === 0xfe80 ||                // fe80::/10 link-local
      (w[0] & 0xffc0) === 0xfec0 ||                // fec0::/10 site-local (deprecated)
      (w[0] & 0xff00) === 0xff00                   // ff00::/8 multicast
    );
  }

  const m = v.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const o1 = Number(m[1]);
  const o2 = Number(m[2]);
  return (
    o1 === 0 ||                              // 0.0.0.0/8
    o1 === 10 ||                             // 10.0.0.0/8 private
    o1 === 127 ||                            // 127.0.0.0/8 loopback
    (o1 === 100 && o2 >= 64 && o2 <= 127) || // 100.64.0.0/10 shared
    (o1 === 169 && o2 === 254) ||            // 169.254.0.0/16 link-local / cloud metadata
    (o1 === 172 && o2 >= 16 && o2 <= 31) ||  // 172.16.0.0/12 private
    (o1 === 192 && o2 === 168) ||            // 192.168.0.0/16 private
    (o1 === 198 && (o2 === 18 || o2 === 19)) || // 198.18.0.0/15 benchmarking
    o1 >= 224                                // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved, broadcast
  );
}
