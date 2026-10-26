// Every API route. Health is open; everything else needs a token (or the same-origin UI proxy).
import { randomUUID } from "node:crypto";
import express, { type Request, type Router } from "express";
import type { EntryId, SubmissionId } from "@earendil-works/pi-durable";
import {
  messageText,
  toTranscript,
  type Health,
  type Info,
  type SendResult,
  type WireEntry,
  type WireMessage,
} from "@rh/sdk";
import { requireAuth } from "./auth.ts";
import { ApiFault, int, invalid, notFound, optInt } from "./errors.ts";
import type { Hub } from "./hub.ts";
import type { ProjectRuntime } from "./project.ts";
import { agentState } from "./state.ts";
import type { StreamHub } from "./sse.ts";
import { packageVersion, VERSION } from "./version.ts";
import { KERNEL_API_VERSION } from "./kernel/manifest.ts";

const MAX_MESSAGE = 100_000;

function bodyOf(req: Request): Record<string, unknown> {
  const body = req.body;
  if (body === undefined) return {};
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("Body must be a JSON object");
  return body as Record<string, unknown>;
}

export function routes(hub: Hub, streams: StreamHub): Router {
  const r = express.Router();
  const health = (): Health => ({
    ok: true,
    project: hub.name,
    version: VERSION,
    mode: hub.config.mode,
    providers: hub.providers,
  });

  r.get("/v1/health", (_req, res) => void res.json(health()));
  r.use("/v1", requireAuth(hub.log));
  r.get("/v1/info", (_req, res) => {
    const info: Info = {
      ...health(),
      piDurable: packageVersion("@earendil-works/pi-durable"),
      models: hub.catalog.jobs,
      jevModel: hub.config.mode === "offline" ? "mock" : hub.config.jevModel,
      uptimeMs: Date.now() - hub.startedAt,
      kbViewer: hub.project.kbViewer.status(),
      kernelApi: KERNEL_API_VERSION,
      plugins: hub.project.plugins.kernel.list().map(({ id, version, state }) => ({ id, version, state })),
    };
    res.json(info);
  });

  const project = (_req?: Request): Promise<ProjectRuntime> => Promise.resolve(hub.project);

  r.get("/v1/agent", async (req, res) => void res.json(await agentState(await project(req))));

  r.post("/v1/chat", async (req, res) => {
    const p = await project(req);
    const body = bodyOf(req);
    const content = body.content;
    if (typeof content !== "string" || !content.trim()) throw invalid("content must be a nonblank string");
    if (content.length > MAX_MESSAGE) throw invalid(`content must be at most ${MAX_MESSAGE} characters`);
    const requestId = body.requestId === undefined ? randomUUID() : body.requestId;
    if (typeof requestId !== "string" || requestId.length > 128)
      throw invalid("requestId must be a string of at most 128 characters");
    const waitMs = body.waitMs === undefined ? 0 : Number(body.waitMs);
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 300_000) throw invalid("waitMs must be 0 to 300000");
    const { harness, ctx } = p.harness;
    const submission = await p.root.submit(
      { type: "input", content, requestId: `chat:${requestId}`, whenBusy: "followUp" },
      ctx,
    );
    hub.log.info("agent.message", { submissionId: submission.id, chars: content.length });
    let record = await submission.status(ctx);
    if (waitMs > 0 && record.status !== "done" && record.status !== "unanswered") {
      const closed = new AbortController();
      res.on("close", () => closed.abort());
      const stop = AbortSignal.any([AbortSignal.timeout(waitMs), closed.signal]);
      const aborted = new Promise<undefined>((ok) =>
        stop.addEventListener("abort", () => ok(undefined), { once: true }),
      );
      record = (await Promise.race([submission.wait(ctx), aborted])) ?? (await submission.status(ctx));
    }
    let result: SendResult;
    if (record.status === "done" && record.answer !== undefined) {
      const entry = await harness.commit((tx) => tx.entry(record.answer as EntryId), ctx);
      const text = (entry?.model ?? [])
        .map((m) => messageText(m as WireMessage))
        .join("")
        .trim();
      result = {
        submissionId: submission.id as number,
        status: "done",
        answer: { entryId: record.answer as number, text },
      };
    } else if (record.status === "unanswered") {
      result = {
        submissionId: submission.id as number,
        status: "unanswered",
        reason: (record as { reason?: string }).reason,
      };
    } else {
      result = { submissionId: submission.id as number, status: record.status === "queued" ? "queued" : "pending" };
    }
    res.status(result.status === "done" || result.status === "unanswered" ? 200 : 202).json(result);
  });

  r.get("/v1/submissions/:id", async (req, res) => {
    const p = await project(req);
    const submission = await p.harness.harness.submission(int(req.params.id, "id") as unknown as SubmissionId, p.ctx);
    if (!submission) throw notFound(`No submission ${req.params.id}`);
    res.json(await submission.status(p.ctx));
  });

  r.get("/v1/transcript", async (req, res) => {
    const p = await project(req);
    const view = await p.root.viewState(p.ctx);
    let entries: WireEntry[];
    try {
      entries = JSON.parse(JSON.stringify(view.value.entries)) as WireEntry[];
    } finally {
      view.dispose();
    }
    res.json({ conversationId: p.root.id, items: toTranscript(entries) });
  });

  r.get("/v1/runs", async (req, res) => {
    const p = await project(req);
    res.json(
      p.telemetry.runs({
        limit: Math.min(int(req.query.limit, "limit", 50), 200),
        before: optInt(req.query.before, "before"),
      }),
    );
  });

  r.get("/v1/runs/:id", async (req, res) => {
    const run = (await project(req)).telemetry.run(int(req.params.id, "id"));
    if (!run) throw notFound(`No run ${req.params.id}`);
    res.json(run);
  });

  r.get("/v1/usage", async (req, res) => void res.json((await project(req)).telemetry.totals()));

  r.post("/v1/jev/ping", async (req, res) => {
    const p = await project(req);
    const text = bodyOf(req).text;
    if (text !== undefined && (typeof text !== "string" || text.length > 1000))
      throw invalid("text must be a string of at most 1000 characters");
    res.json(await p.jevPing(text as string | undefined));
  });

  r.get("/v1/stream", async (req, res) => {
    if (streams.closing) throw new ApiFault("unavailable", "The server is shutting down");
    await streams.serve(await project(req), hub.log, req, res);
  });

  return r;
}
