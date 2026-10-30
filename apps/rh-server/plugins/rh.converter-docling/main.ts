// Built-in plugin rh.converter-docling (spec full-text: Converter slot; design v1-6 D3): PDFs through Docling Serve,
// (its async API: submit, poll, collect), either one at RH_DOCLING_URL or, with RH_DOCLING=on (the research-hub:full image), a local `docling-serve` this
// plugin starts on first use and supervises (restarted with backoff). Markdown out, split into sections.
import { spawn, type ChildProcess } from "node:child_process";
import { hostOf } from "../../src/kernel/builtin.ts";
import type { PluginContext } from "../../src/kernel/lifecycle.ts";
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
  let child: ChildProcess | undefined;
  let starting: Promise<void> | undefined;
  let stopped = false;
  let restarts = 0;

  const healthy = async () => {
    try {
      return (await fetch(`${base}/health`, { signal: AbortSignal.timeout(3_000) })).ok;
    } catch {
      return false;
    }
  };
  const start = (): Promise<void> => {
    if (external || stopped) return Promise.resolve();
    starting ??= (async () => {
      if (await healthy()) return;
      const cmd = process.env.RH_DOCLING_CMD?.trim() || "docling-serve";
      child = spawn(cmd, ["run", "--host", "127.0.0.1", "--port", String(port)], {
        stdio: ["ignore", "ignore", "pipe"],
        // A long paper takes minutes on CPU; Docling Serve's default 120 s answers 504.
        env: { ...process.env, DOCLING_SERVE_MAX_SYNC_WAIT: process.env.DOCLING_SERVE_MAX_SYNC_WAIT ?? "600" },
      });
      let stderr = "";
      child.stderr?.on("data", (d) => (stderr = (stderr + String(d)).slice(-2_000)));
      child.on("exit", (code) => {
        child = undefined;
        starting = undefined;
        if (stopped) return;
        host.log.warn("docling.exited", { code, stderr: stderr.slice(-500) });
        // Restart on the next conversion, with a growing pause.
        restarts++;
      });
      const deadline = Date.now() + START_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (!child) throw new Error(`docling-serve exited while starting: ${stderr.slice(-300)}`);
        if (await healthy()) {
          host.log.info("docling.started", { port });
          return;
        }
        await new Promise((r) => setTimeout(r, 1_000));
      }
      throw new Error("docling-serve did not start within 3 minutes");
    })();
    return starting;
  };
  context.subscriptions.push({
    dispose: () => {
      stopped = true;
      child?.kill("SIGTERM");
    },
  });

  return {
    available: () => {
      if (!external && !local)
        return { ok: false, reason: "needs the research-hub:full image (RH_DOCLING=on) or RH_DOCLING_URL" };
      if (restarts > 5) return { ok: false, reason: "docling-serve keeps exiting (see the log)" };
      return { ok: true };
    },
    async convert(pdf) {
      if (restarts) await new Promise((r) => setTimeout(r, Math.min(30_000, 1_000 * 2 ** restarts)));
      await start();
      return markdownToSections(await doclingMarkdown(base, pdf));
    },
  };
}
