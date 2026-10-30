// Built-in plugin rh.converter-docling (spec full-text: Converter slot; design v1-6 D3): PDFs through Docling Serve,
// (its async API: submit, poll, collect), either one at RH_DOCLING_URL or, with RH_DOCLING=on (the research-hub:full image), a local `docling-serve` this
// plugin starts on first use and supervises (restarted with backoff). Markdown out, split into sections.
import { hostOf } from "../../src/kernel/builtin.ts";
import type { PluginContext } from "../../src/kernel/lifecycle.ts";
import { LocalServer } from "../../src/kernel/local-server.ts";
import { markdownToSections } from "../../src/fulltext/parse.ts";
import type { ConverterExports } from "../rh.fulltext/main.ts";

export const START_TIMEOUT_MS = 180_000;
export const CONVERT_TIMEOUT_MS = 600_000;
export const POLL_MS = Number(process.env.RH_DOCLING_POLL_MS ?? 2_000);

/** Submit a PDF to Docling Serve's async API (a long paper takes minutes on CPU); returns the task id. */
async function submit(base: string, pdf: Uint8Array): Promise<string> {
  const form = new FormData();
  form.append("files", new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), "paper.pdf");
  form.append("to_formats", "md");
  form.append("image_export_mode", "placeholder");
  form.append("do_ocr", "false");
  const submitted = await fetch(`${base}/v1/convert/file/async`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!submitted.ok)
    throw new Error(`docling-serve: HTTP ${submitted.status} ${(await submitted.text()).slice(0, 200)}`);
  const { task_id: task } = (await submitted.json()) as { task_id?: string };
  if (!task) throw new Error("docling-serve: no task id (an older Docling Serve without the async API?)");
  return task;
}

/** Poll until the task succeeds; a failure or more than CONVERT_TIMEOUT_MS is an error. */
async function waitForTask(base: string, task: string): Promise<void> {
  const deadline = Date.now() + CONVERT_TIMEOUT_MS;
  for (;;) {
    const poll = (await (
      await fetch(`${base}/v1/status/poll/${task}`, { signal: AbortSignal.timeout(30_000) })
    ).json()) as { task_status?: string; error_message?: string | null };
    if (poll.task_status === "success") return;
    if (poll.task_status === "failure") throw new Error(`docling-serve: ${poll.error_message ?? "conversion failed"}`);
    if (Date.now() > deadline) throw new Error("docling-serve: conversion took more than 10 minutes");
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/** A PDF as Markdown, through Docling Serve at `base`. */
async function doclingMarkdown(base: string, pdf: Uint8Array): Promise<string> {
  const task = await submit(base, pdf);
  await waitForTask(base, task);
  const response = await fetch(`${base}/v1/result/${task}`, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`docling-serve: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
  const body = (await response.json()) as { document?: { md_content?: string }; status?: string; errors?: unknown[] };
  if (!body.document?.md_content)
    throw new Error(
      `docling-serve: ${body.status ?? "no markdown"} ${JSON.stringify(body.errors ?? []).slice(0, 200)}`,
    );
  return body.document.md_content;
}

export function activate(context: PluginContext): ConverterExports {
  const host = hostOf(context);
  const external = process.env.RH_DOCLING_URL?.trim().replace(/\/$/, "");
  const local = (process.env.RH_DOCLING?.trim().toLowerCase() ?? "off") === "on";
  const port = Number(process.env.RH_DOCLING_PORT ?? 5001);
  const base = external || `http://127.0.0.1:${port}`;
  const server = new LocalServer({
    base,
    command: process.env.RH_DOCLING_CMD?.trim() || "docling-serve",
    args: ["run", "--host", "127.0.0.1", "--port", String(port)],
    // A long paper takes minutes on CPU; Docling Serve's default 120 s answers 504.
    env: { ...process.env, DOCLING_SERVE_MAX_SYNC_WAIT: process.env.DOCLING_SERVE_MAX_SYNC_WAIT ?? "600" },
    name: "docling-serve",
    event: "docling",
    startTimeoutMs: START_TIMEOUT_MS,
    log: host.log,
  });
  // An external Docling Serve is not ours to start.
  const start = () => (external ? Promise.resolve() : server.start());
  context.subscriptions.push({ dispose: () => server.stop() });

  return {
    available: () => {
      if (!external && !local)
        return { ok: false, reason: "needs the research-hub:full image (RH_DOCLING=on) or RH_DOCLING_URL" };
      if (server.restarts > 5) return { ok: false, reason: "docling-serve keeps exiting (see the log)" };
      return { ok: true };
    },
    async convert(pdf) {
      // Restart after an exit with a growing pause.
      const { restarts } = server;
      if (restarts) await new Promise((r) => setTimeout(r, Math.min(30_000, 1_000 * 2 ** restarts)));
      await start();
      return markdownToSections(await doclingMarkdown(base, pdf));
    },
  };
}
