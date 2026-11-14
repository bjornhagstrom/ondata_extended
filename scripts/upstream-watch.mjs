#!/usr/bin/env node
/**
 * Upstream watch: lists the commits in ondata's servers since the baselines in scripts/upstream-watch.json and
 * classifies each by the files it touches (which of our packages it maps to). Commits that touch only ignored paths
 * or have an ignored subject (bot data updates) are counted, not listed. Decides nothing: whether a change is ported,
 * noted or dismissed is reviewed in a session, after which the baseline is moved by hand.
 *
 *   node scripts/upstream-watch.mjs            prints the report (Markdown) to stdout
 *   node scripts/upstream-watch.mjs --issue    also keeps one issue in this repository up to date (GitHub Action):
 *                                               opens it when there is something to review, comments when new
 *                                               commits appear (that is the ping), closes it when nothing is left
 *
 * Token: GITHUB_TOKEN or GH_TOKEN (optional for the report; required for --issue, with GITHUB_REPOSITORY=owner/name).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = join(fileURLToPath(import.meta.url), "..");
const CONFIG = JSON.parse(readFileSync(join(HERE, "upstream-watch.json"), "utf8"));
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const MARKER = "<!-- upstream-watch -->";

async function gh(path, init = {}) {
  const res = await fetch(`https://api.github.com/${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "upstream-watch",
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${init.method || "GET"} ${path}: HTTP ${res.status}`);
  return res.status === 204 ? null : res.json();
}

const startsWithAny = (file, prefixes) => prefixes.some((p) => file === p || file.startsWith(p));

function classify(file, repo) {
  if (startsWithAny(file, repo.ignorePaths)) return null;
  const area = repo.areas.find((a) => startsWithAny(file, a.paths));
  return area ? area.ours : "unmapped";
}

async function watchRepo(repo) {
  const cmp = await gh(`repos/${repo.repo}/compare/${repo.baseline}...HEAD`);
  const ignoreSubject = repo.ignoreSubjects.map((s) => new RegExp(s));
  const relevant = [];
  let ignored = 0;
  for (const c of cmp.commits) {
    const subject = c.commit.message.split("\n")[0];
    if (ignoreSubject.some((re) => re.test(subject))) { ignored++; continue; }
    const detail = await gh(`repos/${repo.repo}/commits/${c.sha}`);
    const areas = new Map();
    for (const f of detail.files || []) {
      const ours = classify(f.filename, repo);
      if (ours) areas.set(ours, [...(areas.get(ours) || []), f.filename]);
    }
    if (areas.size === 0) { ignored++; continue; }
    relevant.push({ sha: c.sha, subject, url: c.html_url, areas });
  }
  const head = cmp.commits.length ? cmp.commits[cmp.commits.length - 1].sha : cmp.base_commit.sha;
  let release = "";
  try { release = (await gh(`repos/${repo.repo}/releases/latest`)).tag_name; } catch { /* no releases */ }
  return { repo, ahead: cmp.ahead_by, head, release, relevant, ignored };
}

function report(results) {
  const out = [MARKER, "# Upstream changes to review", ""];
  for (const r of results) {
    out.push(`## ${r.repo.repo} (${r.repo.key})`, "",
      `Baseline \`${r.repo.baseline}\`, upstream head \`${r.head.slice(0, 7)}\`${r.release ? `, latest release ${r.release}` : ""}: ` +
      `${r.ahead} commits, ${r.relevant.length} to review, ${r.ignored} ignored (data updates, docs and other unmapped-out paths).`, "");
    for (const c of r.relevant) {
      out.push(`- [\`${c.sha.slice(0, 7)}\`](${c.url}) ${c.subject}`);
      for (const [ours, files] of c.areas) {
        const shown = files.slice(0, 5).map((f) => `\`${f}\``).join(", ");
        out.push(`  - ${ours}: ${shown}${files.length > 5 ? ` and ${files.length - 5} more` : ""}`);
      }
    }
    if (r.relevant.length) out.push("");
  }
  out.push("Review each in a session (port, note or dismiss), then move the baseline in `scripts/upstream-watch.json`.");
  const shas = results.flatMap((r) => r.relevant.map((c) => c.sha.slice(0, 7)));
  out.push("", `<!-- shas: ${shas.join(" ")} -->`);
  return { text: out.join("\n"), shas };
}

async function syncIssue({ text, shas }) {
  const target = process.env.GITHUB_REPOSITORY;
  if (!TOKEN || !target) throw new Error("--issue needs GITHUB_TOKEN and GITHUB_REPOSITORY");
  const open = (await gh(`repos/${target}/issues?state=open&per_page=100`))
    .find((i) => !i.pull_request && (i.body || "").startsWith(MARKER));
  if (!shas.length) {
    if (open) {
      await gh(`repos/${target}/issues/${open.number}/comments`, { method: "POST", body: JSON.stringify({ body: "All baselines are up to date; closing." }) });
      await gh(`repos/${target}/issues/${open.number}`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) });
      console.log(`closed #${open.number}`);
    }
    return;
  }
  if (!open) {
    const made = await gh(`repos/${target}/issues`, { method: "POST", body: JSON.stringify({ title: "Upstream: ondata changes to review", body: text }) });
    console.log(`opened #${made.number}`);
    return;
  }
  const before = ((open.body || "").match(/<!-- shas: ([^>]*) -->/) || [, ""])[1].split(" ").filter(Boolean);
  const added = shas.filter((s) => !before.includes(s));
  await gh(`repos/${target}/issues/${open.number}`, { method: "PATCH", body: JSON.stringify({ body: text }) });
  if (added.length) {
    await gh(`repos/${target}/issues/${open.number}/comments`, { method: "POST", body: JSON.stringify({ body: `New upstream commits to review: ${added.map((s) => `\`${s}\``).join(", ")}.` }) });
  }
  console.log(`updated #${open.number}, ${added.length} new`);
}

const results = [];
for (const repo of CONFIG.repos) results.push(await watchRepo(repo));
const rep = report(results);
console.log(rep.text);
if (process.argv.includes("--issue")) await syncIssue(rep);
