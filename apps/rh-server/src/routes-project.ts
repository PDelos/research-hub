// The project's direction: brief, charter (draft, edit, answers, approval, retry, versions) and pause/resume.
import express, { type Request, type Router } from "express";
import { BriefInvalid, CharterInvalid, validateCharter } from "./charter.ts";
import { requireAuth } from "./auth.ts";
import { CharterBusy } from "./charter-writer.ts";
import { ApiFault, int, invalid, notFound } from "./errors.ts";
import type { Hub } from "./hub.ts";

function bodyOf(req: Request): Record<string, unknown> {
  const body = req.body;
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
  const r = express.Router();
  r.use("/v1", requireAuth(hub.log));
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
  r.get("/v1/brief", (_req, res) => {
    const text = p().brief.read();
    res.json({ brief: text ?? null, chars: text ? [...text].length : 0, status: p().state.status() });
  });

  r.put("/v1/brief", async (req, res) => {
    if (p().charterWriter.run()?.status === "running") throw busy();
    try {
      p().brief.write(bodyOf(req).brief);
      await p().charterWriter.draft();
    } catch (error) {
      fault(error);
    }
    res.json(charterView());
  });

  r.get("/v1/charter", (_req, res) => void res.json(charterView()));

  r.get("/v1/charter/versions/:n", (req, res) => {
    const record = p().charters.version(int(req.params.n, "n"));
    if (!record) throw notFound(`No charter version ${req.params.n}`);
    res.json(record);
  });

  r.put("/v1/charter", (req, res) => {
    if (p().charterWriter.run()?.status === "running") throw busy();
    try {
      p().charters.saveDraft(validateCharter(bodyOf(req).charter), "user");
    } catch (error) {
      fault(error);
    }
    res.json(charterView());
  });

  r.post("/v1/charter/answers", async (req, res) => {
    const answers = bodyOf(req).answers;
    if (!Array.isArray(answers) || !answers.length) throw invalid("answers must be a nonempty list of {id, answer}");
    const open = new Map(p().questions.open().map((q) => [q.id, q]));
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
    res.json(charterView());
  });

  r.post("/v1/charter/approve", (_req, res) => {
    if (p().charterWriter.run()?.status === "running") throw busy();
    const approved = p().charters.approve();
    if (!approved) throw new ApiFault("conflict", "There is no draft to approve");
    hub.log.info("charter.approved", { version: approved.version });
    res.json(charterView());
  });

  r.post("/v1/charter/retry", async (_req, res) => {
    const run = p().charterWriter.run();
    if (!run || run.status !== "failed") throw new ApiFault("conflict", "There is no failed charter run to retry");
    try {
      await p().charterWriter.retry();
    } catch (error) {
      fault(error);
    }
    res.json(charterView());
  });

  r.post("/v1/project/pause", (_req, res) => {
    p().state.pause();
    hub.log.info("project.paused", {});
    res.json({ status: p().state.status() });
  });

  r.post("/v1/project/resume", (_req, res) => {
    p().state.resume();
    hub.log.info("project.resumed", {});
    res.json({ status: p().state.status() });
  });

  return r;
}
