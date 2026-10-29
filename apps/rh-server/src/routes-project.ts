// The project's direction: brief, charter (draft, edit, answers, approval, retry, versions) and pause/resume.
import express, { type Request, type Router } from "express";
import { BriefInvalid, CharterInvalid, validateCharter } from "./charter.ts";
import { requireAuth } from "./auth.ts";
import { CharterBusy } from "./charter-writer.ts";
import { ApiFault, int, invalid, notFound } from "./errors.ts";
import { ScheduleInvalid } from "./schedule.ts";
import type { Hub } from "./hub.ts";

function bodyOf(request: Request): Record<string, unknown> {
  const body = request.body;
  if (body === undefined) return {};
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("Body must be a JSON object");
  return body as Record<string, unknown>;
}

const busy = () => new ApiFault("busy", "A charter run is already in progress; wait for it to finish");

/** Map domain errors to API faults. */
function fault(error: unknown): never {
  if (error instanceof BriefInvalid) throw invalid(error.message);
  if (error instanceof CharterInvalid) throw invalid(`Charter is invalid: ${error.problems.join("; ")}`);
  if (error instanceof CharterBusy) throw busy();
  throw error;
}

export function projectRoutes(hub: Hub): Router {
  const router = express.Router();
  router.use("/v1", requireAuth(hub.log));
  const p = () => hub.project;
  const charterView = () => {
    const { charters, questions, charterWriter } = p();
    const run = charterWriter.run();
    return {
      status: p().state.status(),
      draft: charters.draft() ?? null,
      approved: charters.approved() ?? null,
      versions: charters.versions(),
      questions: questions.all(),
      questionsLeft: questions.remaining(),
      run: run ? { ...run, prompt: undefined } : null,
    };
  };
  router.get("/v1/brief", (_request, response) => {
    const text = p().brief.read();
    response.json({ brief: text ?? null, chars: text ? [...text].length : 0, status: p().state.status() });
  });

  router.put("/v1/brief", async (request, response) => {
    if (p().charterWriter.run()?.status === "running") throw busy();
    try {
      p().brief.write(bodyOf(request).brief);
      await p().charterWriter.draft();
    } catch (error) {
      fault(error);
    }
    response.json(charterView());
  });

  router.get("/v1/charter", (_request, response) => void response.json(charterView()));

  router.get("/v1/charter/versions/:n", (request, response) => {
    const record = p().charters.version(int(request.params.n, "n"));
    if (!record) throw notFound(`No charter version ${request.params.n}`);
    response.json(record);
  });

  router.put("/v1/charter", (request, response) => {
    if (p().charterWriter.run()?.status === "running") throw busy();
    try {
      p().charters.saveDraft(validateCharter(bodyOf(request).charter), "user");
    } catch (error) {
      fault(error);
    }
    response.json(charterView());
  });

  router.post("/v1/charter/answers", async (request, response) => {
    const answers = bodyOf(request).answers;
    if (!Array.isArray(answers) || !answers.length) throw invalid("answers must be a nonempty list of {id, answer}");
    const open = new Map(
      p()
        .questions.open()
        .map((q) => [q.id, q]),
    );
    const clean = answers.map((a, i) => {
      const id = Number((a as any)?.id);
      const answer = (a as any)?.answer;
      if (!open.has(id)) throw invalid(`answers[${i + 1}]: question ${(a as any)?.id} is not an open scoping question`);
      if (typeof answer !== "string" || !answer.trim() || answer.length > 2000)
        throw invalid(`answers[${i + 1}]: answer must be 1 to 2000 characters`);
      return { id, answer: answer.trim() };
    });
    if (p().charterWriter.run()?.status === "running") throw busy();
    const answered = p().questions.answer(clean);
    try {
      await p().charterWriter.revise(answered.map((q) => ({ question: q.text, answer: q.answer ?? "" })));
    } catch (error) {
      fault(error);
    }
    response.json(charterView());
  });

  router.post("/v1/charter/approve", (_request, response) => {
    if (p().charterWriter.run()?.status === "running") throw busy();
    const approved = p().charters.approve();
    if (!approved) throw new ApiFault("conflict", "There is no draft to approve");
    hub.log.info("charter.approved", { version: approved.version });
    // Weights replay onto the new version's base weights.
    p().feedback.replay();
    p().syncVault();
    response.json(charterView());
  });

  router.post("/v1/charter/retry", async (_request, response) => {
    const run = p().charterWriter.run();
    if (!run || run.status !== "failed") throw new ApiFault("conflict", "There is no failed charter run to retry");
    try {
      await p().charterWriter.retry();
    } catch (error) {
      fault(error);
    }
    response.json(charterView());
  });

  router.get("/v1/project", (_request, response) => {
    const project = p();
    const approved = project.charters.approved();
    response.json({
      name: project.name,
      status: project.state.status(),
      charterVersion: approved?.version ?? null,
      hasDraft: !!project.charters.draft(),
      charterRun: project.charterWriter.run()?.status ?? null,
      paused: project.state.paused() ?? null,
      next: project.scheduler.next(),
      monthCostUsd: project.telemetry.totals().monthUsd,
    });
  });

  router.get("/v1/schedule", (_request, response) => void response.json(p().scheduler.schedule()));

  router.put("/v1/schedule", (request, response) => {
    try {
      response.json(p().scheduler.setSchedule(bodyOf(request)));
    } catch (error) {
      if (error instanceof ScheduleInvalid) throw invalid(error.message);
      throw error;
    }
  });

  router.get("/v1/scheduled-runs", (request, response) => {
    response.json(p().scheduler.runs(Math.min(int(request.query.limit, "limit", 100), 500)));
  });

  router.post("/v1/runs/:kind", (request, response) => {
    const kind = request.params.kind;
    if (kind !== "sweep" && kind !== "nightly" && kind !== "review") throw notFound(`No run kind ${kind}`);
    const run = p().scheduler.trigger(kind);
    response.status(run.status === "requested" ? 202 : 200).json(run);
  });

  router.post("/v1/project/pause", (_request, response) => {
    p().state.pause();
    hub.log.info("project.paused", {});
    response.json({ status: p().state.status() });
  });

  router.post("/v1/project/resume", (_request, response) => {
    p().state.resume();
    hub.log.info("project.resumed", {});
    response.json({ status: p().state.status() });
  });

  return router;
}
