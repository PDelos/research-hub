// The project's knowledge base as an Obsidian-compatible vault (spec knowledge-vault; design D1, D3). The vault is
// the user's: the hub creates files and pages, appends under designated headings and to index.md and log.md, and
// never rewrites what the user wrote. Hub-owned files (charter.md) are only replaced while unchanged by the user.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Charter } from "../charter.ts";
import type { Settings } from "../db.ts";
import type { Logger } from "../logger.ts";

export const VAULT_FOLDERS = ["sources", "concepts", "questions"] as const;
const CHARTER_HASH = "vault_charter_hash";

export const INDEX_HEADER =
  "# Knowledge base\n\nOne line per paper: title · summary · level · your reason.\n\n## Papers\n\n";
export const LOG_HEADER = "# Log\n\n";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** Lowercase ASCII words joined by "-" (accents folded, everything else dropped). */
export function slug(text: string, words = Infinity): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, words)
    .join("-");
}

/** `{first-author-lastname}-{year}-{first-5-title-words}`, e.g. "lin-2023-evolutionary-scale-prediction-of-atomic". */
export function noteStem(paper: { authors: string[]; year?: number; title: string }): string {
  const first = (paper.authors[0] ?? "").trim();
  // "Lin Z" (Europe PMC) → "lin"; "Zeming Lin" → "lin"; "Lin, Zeming" → "lin".
  let last = first.includes(",") ? first.split(",")[0] : first;
  const parts = last.split(/\s+/).filter(Boolean);
  if (!first.includes(",") && parts.length > 1) last = /^[A-Z]{1,3}$/.test(parts.at(-1)!) ? parts[0] : parts.at(-1)!;
  return [slug(last) || "anon", String(paper.year ?? "nd"), slug(paper.title, 5) || "untitled"].join("-");
}

export function renderCharter(charter: Charter, version: number): string {
  const lines = [`# Charter (version ${version})`, "", "## Research questions", ""];
  for (const q of charter.questions) lines.push(`- **${q.id}** (weight ${q.weight}): ${q.text}`);
  lines.push("", "## Concepts", "", ...charter.concepts.map((c) => `- ${c}`));
  lines.push("", "## Sub-areas", "", ...charter.subAreas.map((c) => `- ${c}`));
  lines.push("", "## Search queries", "", ...charter.queries.map((q) => `- ${q.text} (weight ${q.weight})`));
  lines.push(
    "",
    "## Out of scope",
    "",
    ...(charter.outOfScope.length ? charter.outOfScope.map((c) => `- ${c}`) : ["- (none)"]),
  );
  return `${lines.join("\n")}\n`;
}

export class Vault {
  constructor(
    readonly dir: string,
    private readonly deps: { templateDir: string; settings: Settings; log: Logger },
  ) {}

  exists(): boolean {
    return existsSync(join(this.dir, "index.md"));
  }

  /** Create the layout; never overwrite existing files (and never reset the user's Obsidian settings). */
  ensure(): boolean {
    const created = !this.exists();
    for (const folder of VAULT_FOLDERS) mkdirSync(join(this.dir, folder), { recursive: true });
    // Obsidian settings from the template: only files that are missing (a new setting such as the graph colors
    // reaches existing vaults), never overwriting what is there, so the user's own choices are kept.
    const template = join(this.deps.templateDir, ".obsidian");
    if (existsSync(template))
      cpSync(template, join(this.dir, ".obsidian"), { recursive: true, force: false, errorOnExist: false });
    if (!existsSync(join(this.dir, "index.md"))) this.write("index.md", INDEX_HEADER);
    if (!existsSync(join(this.dir, "log.md"))) this.write("log.md", LOG_HEADER);
    if (created) this.deps.log.info("vault.created", { dir: this.dir });
    return created;
  }

  /** Write charter.md unless the user changed the copy the hub wrote last; returns whether it was written. */
  writeCharter(charter: Charter, version: number): boolean {
    const path = join(this.dir, "charter.md");
    const last = this.deps.settings.get<string | null>(CHARTER_HASH, null);
    if (existsSync(path) && sha(readFileSync(path, "utf8")) !== last) {
      this.deps.log.info("vault.charter_kept", { reason: "edited by the user" });
      return false;
    }
    const text = renderCharter(charter, version);
    this.write("charter.md", text);
    this.deps.settings.set(CHARTER_HASH, sha(text));
    return true;
  }

  /** A free stem: the base name, or with -2, -3 … when a different note already uses it. */
  freeStem(base: string): string {
    let stem = base;
    for (let n = 2; existsSync(join(this.dir, "sources", `${stem}.md`)); n++) stem = `${base}-${n}`;
    return stem;
  }

  read(rel: string): string | undefined {
    const path = join(this.dir, rel);
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  }

  /** Create a file that must not exist yet (the hub never overwrites notes). Returns false if it already exists. */
  create(rel: string, text: string): boolean {
    if (existsSync(join(this.dir, rel))) return false;
    this.write(rel, text);
    return true;
  }

  /** Append a line at the end of the section under `heading` (added at the end of the file when missing). */
  appendUnderHeading(rel: string, heading: string, line: string): void {
    const current = this.read(rel) ?? "";
    this.write(rel, appendUnderHeading(current, heading, line));
  }

  appendIndex(line: string): void {
    this.appendUnderHeading("index.md", "## Papers", line);
  }

  appendLog(entry: string): void {
    const current = this.read("log.md") ?? LOG_HEADER;
    this.write(
      "log.md",
      `${current.endsWith("\n") ? current : `${current}\n`}- ${new Date().toISOString().slice(0, 16).replace("T", " ")} ${entry}\n`,
    );
  }

  /** Every markdown file in the vault (relative paths, sorted), except Obsidian's settings. */
  markdownFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".md")) out.push(relative(this.dir, full));
      }
    };
    walk(this.dir);
    return out.sort();
  }

  /** Atomic write (temp file + rename), so Obsidian and the watcher never see half a file. */
  private write(rel: string, text: string): void {
    const path = join(this.dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    const temporaryPath = join(dirname(path), `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
    writeFileSync(temporaryPath, text);
    renameSync(temporaryPath, path);
  }
}

/** Insert `line` at the end of the section under `heading`, leaving every other byte unchanged. */
export function appendUnderHeading(text: string, heading: string, line: string): string {
  const level = heading.match(/^#+/)?.[0].length ?? 2;
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === heading.trim());
  if (start === -1) return `${text.replace(/\n*$/, "")}${text.trim() ? "\n\n" : ""}${heading}\n\n${line}\n`;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const headingMatch = lines[i].match(/^(#+)\s/);
    if (headingMatch && headingMatch[1].length <= level) {
      end = i;
      break;
    }
  }
  // Insert after the section's last non-empty line.
  let at = end;
  while (at > start + 1 && lines[at - 1].trim() === "") at--;
  const blankAfter = at < lines.length && lines[at]?.trim() !== "" ? [""] : [];
  const before = at === start + 1 ? [""] : [];
  lines.splice(at, 0, ...before, line, ...blankAfter);
  return lines.join("\n");
}
