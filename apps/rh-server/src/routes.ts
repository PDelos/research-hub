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

function bodyOf(request: Request): Record<string, unknown> {
  const body = request.body;
  if (body === undefined) return {};
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("Body must be a JSON object");
  return body as Record<string, unknown>;
}

type Harness = ProjectRuntime["harness"]["harness"];
type HarnessContext = ProjectRuntime["harness"]["ctx"];
type Submission = Awaited<ReturnType<ProjectRuntime["root"]["submit"]>>;
type SubmissionRecord = Awaited<ReturnType<Submission["status"]>>;

/** The checked body of POST /v1/chat. */
function chatInput(body: Record<string, unknown>) {
  const content = body.content;
  if (typeof content !== "string" || !content.trim()) throw invalid("content must be a nonblank string");
  if (content.length > MAX_MESSAGE) throw invalid(`content must be at most ${MAX_MESSAGE} characters`);
  const requestId = body.requestId === undefined ? randomUUID() : body.requestId;
  if (typeof requestId !== "string" || requestId.length > 128)
    throw invalid("requestId must be a string of at most 128 characters");
  const waitMs = body.waitMs === undefined ? 0 : Number(body.waitMs);
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 300_000) throw invalid("waitMs must be 0 to 300000");
  return { content, requestId, waitMs };
}

/** The submission's state after waiting up to `waitMs` for an answer, or until the client goes away. */
async function settledWithin(
  submission: Submission,
  context: HarnessContext,
  waitMs: number,
  closed: AbortSignal,
): Promise<SubmissionRecord> {
  const record = await submission.status(context);
  if (waitMs === 0 || record.status === "done" || record.status === "unanswered") return record;
  const stop = AbortSignal.any([AbortSignal.timeout(waitMs), closed]);
  const aborted = new Promise<undefined>((ok) => stop.addEventListener("abort", () => ok(undefined), { once: true }));
  return (await Promise.race([submission.wait(context), aborted])) ?? (await submission.status(context));
}

/** What POST /v1/chat answers: the reply text when done, the reason when unanswered, otherwise the state. */
async function sendResult(
  harness: Harness,
  context: HarnessContext,
  submission: Submission,
  record: SubmissionRecord,
): Promise<SendResult> {
  const submissionId = submission.id as number;
  if (record.status === "done" && record.answer !== undefined) {
    const entry = await harness.commit((tx) => tx.entry(record.answer as EntryId), context);
    const text = (entry?.model ?? [])
      .map((m) => messageText(m as WireMessage))
      .join("")
      .trim();
    return { submissionId, status: "done", answer: { entryId: record.answer as number, text } };
  }
  if (record.status === "unanswered")
    return { submissionId, status: "unanswered", reason: (record as { reason?: string }).reason };
  return { submissionId, status: record.status === "queued" ? "queued" : "pending" };
}

/** POST /v1/chat: send the agent a message, and wait up to `waitMs` for its answer. */
function chatRoute(router: Router, hub: Hub): void {
  router.post("/v1/chat", async (request, response) => {
    const projectRuntime = hub.project;
    const { content, requestId, waitMs } = chatInput(bodyOf(request));
    const { harness, ctx: context } = projectRuntime.harness;
    const submission = await projectRuntime.root.submit(
      { type: "input", content, requestId: `chat:${requestId}`, whenBusy: "followUp" },
      context,
    );
    hub.log.info("agent.message", { submissionId: submission.id, chars: content.length });
    const closed = new AbortController();
    response.on("close", () => closed.abort());
    const record = await settledWithin(submission, context, waitMs, closed.signal);
    const result = await sendResult(harness, context, submission, record);
    response.status(result.status === "done" || result.status === "unanswered" ? 200 : 202).json(result);
  });
}

export function routes(hub: Hub, streams: StreamHub): Router {
  const router = express.Router();
  const health = (): Health => ({
    ok: true,
    project: hub.name,
    version: VERSION,
    mode: hub.config.mode,
    providers: hub.providers,
  });

  router.get("/v1/health", (_request, response) => void response.json(health()));
  router.use("/v1", requireAuth(hub.log));
  router.get("/v1/info", (_request, response) => {
    const info: Info = {
      ...health(),
      piDurable: packageVersion("@earendil-works/pi-durable"),
      profile: hub.config.profile,
      models: hub.catalog.jobs,
      jevModel: hub.config.mode === "offline" ? "mock" : hub.config.jevModel,
      uptimeMs: Date.now() - hub.startedAt,
      kbViewer: hub.project.kbViewer.status(),
      kernelApi: KERNEL_API_VERSION,
      plugins: hub.project.plugins.kernel.list().map(({ id, version, state }) => ({ id, version, state })),
    };
    response.json(info);
  });

  const project = (_request?: Request): Promise<ProjectRuntime> => Promise.resolve(hub.project);

  router.get("/v1/agent", async (request, response) => void response.json(await agentState(await project(request))));

  chatRoute(router, hub);

  router.get("/v1/submissions/:id", async (request, response) => {
    const projectRuntime = await project(request);
    const submission = await projectRuntime.harness.harness.submission(
      int(request.params.id, "id") as unknown as SubmissionId,
      projectRuntime.ctx,
    );
    if (!submission) throw notFound(`No submission ${request.params.id}`);
    response.json(await submission.status(projectRuntime.ctx));
  });

  router.get("/v1/transcript", async (request, response) => {
    const projectRuntime = await project(request);
    const view = await projectRuntime.root.viewState(projectRuntime.ctx);
    let entries: WireEntry[];
    try {
      entries = JSON.parse(JSON.stringify(view.value.entries)) as WireEntry[];
    } finally {
      view.dispose();
    }
    response.json({ conversationId: projectRuntime.root.id, items: toTranscript(entries) });
  });

  router.get("/v1/runs", async (request, response) => {
    const projectRuntime = await project(request);
    response.json(
      projectRuntime.telemetry.runs({
        limit: Math.min(int(request.query.limit, "limit", 50), 200),
        before: optInt(request.query.before, "before"),
      }),
    );
  });

  router.get("/v1/runs/:id", async (request, response) => {
    const run = (await project(request)).telemetry.run(int(request.params.id, "id"));
    if (!run) throw notFound(`No run ${request.params.id}`);
    response.json(run);
  });

  router.get("/v1/usage", async (request, response) => void response.json((await project(request)).telemetry.totals()));

  router.post("/v1/jev/ping", async (request, response) => {
    const projectRuntime = await project(request);
    const text = bodyOf(request).text;
    if (text !== undefined && (typeof text !== "string" || text.length > 1000))
      throw invalid("text must be a string of at most 1000 characters");
    response.json(await projectRuntime.jevPing(text as string | undefined));
  });

  router.get("/v1/stream", async (request, response) => {
    if (streams.closing) throw new ApiFault("unavailable", "The server is shutting down");
    await streams.serve(await project(request), hub.log, request, response);
  });

  return router;
}
