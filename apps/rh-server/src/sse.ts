// GET /v1/stream: one server-sent event stream per viewer. hello, then agent.snapshot and agent.batch for the
// project's root conversation, plus agent.state and usage whenever a commit changes them. Pings every 15 s and ends
// a stream buffering over 2 MB so a slow viewer reconnects to a fresh snapshot. Closing a stream never aborts work.
// Adapted from disler/pi-durable-news-agent.
import type { Request, Response } from "express";
import { watchEvents } from "@earendil-works/pi-durable";
import { API_VERSION, type Frame } from "@rh/sdk";
import { agentState } from "./state.ts";
import type { Logger } from "./logger.ts";
import type { ProjectRuntime } from "./project.ts";

const MAX_BUFFER = 2_000_000;

export interface Sse {
  send(frame: Frame): void;
  sendIfChanged(key: string, frame: Frame): void;
  onClose(fn: () => void): void;
  close(): void;
  readonly closed: boolean;
}

export function openSse(res: Response): Sse {
  res.status(200).set({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.flushHeaders();
  res.socket?.setNoDelay(true);
  let seq = 0;
  let closed = false;
  const cleanups: (() => void)[] = [];
  const last = new Map<string, string>();
  const ping = setInterval(() => {
    if (!closed) res.write(": ping\n\n");
  }, 15_000);
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {}
    }
  };
  res.on("close", close);
  const send = (frame: Frame) => {
    if (closed) return;
    if (res.writableLength > MAX_BUFFER) {
      res.end();
      close();
      return;
    }
    res.write(`id: ${++seq}\nevent: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
  };
  return {
    send,
    sendIfChanged(key, frame) {
      const json = JSON.stringify(frame);
      if (last.get(key) === json) return;
      last.set(key, json);
      send(frame);
    },
    onClose(fn) {
      if (closed) fn();
      else cleanups.push(fn);
    },
    close() {
      res.end();
      close();
    },
    get closed() {
      return closed;
    },
  };
}

/** Run `fn` at most once per `ms`, never concurrently, always catching up on the latest trigger. */
export function coalesce(fn: () => Promise<void>, ms: number, onError: (e: unknown) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let again = false;
  const run = async () => {
    timer = undefined;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await fn();
    } catch (e) {
      onError(e);
    } finally {
      running = false;
      if (again) {
        again = false;
        trigger();
      }
    }
  };
  const trigger = () => {
    if (!timer) timer = setTimeout(() => void run(), ms);
  };
  return Object.assign(trigger, { now: run, cancel: () => timer && clearTimeout(timer) });
}

export class StreamHub {
  private readonly open = new Set<Sse>();
  closing = false;

  async serve(project: ProjectRuntime, log: Logger, req: Request, res: Response): Promise<void> {
    const { harness, ctx } = project.harness;
    const id = project.root.id;
    const sse = openSse(res);
    this.open.add(sse);
    sse.onClose(() => this.open.delete(sse));
    const slog = log.child({ stream: true });
    slog.debug("stream.open", {});
    sse.send({
      type: "hello",
      apiVersion: API_VERSION,
      serverTime: Date.now(),
      project: project.name,
      mainConversationId: id as number,
    });
    const stream = await watchEvents(harness, id, ctx);
    sse.send({ type: "agent.snapshot", conversationId: id as number, snapshot: JSON.parse(JSON.stringify(stream.snapshot)) });
    stream.start(async (events) => {
      if (!sse.closed)
        sse.send({ type: "agent.batch", conversationId: id as number, events: JSON.parse(JSON.stringify(events)) });
    });
    sse.onClose(() => void stream.stop());
    const state = coalesce(
      async () => {
        if (sse.closed) return;
        sse.sendIfChanged("state", { type: "agent.state", state: await agentState(project) });
        sse.sendIfChanged("usage", { type: "usage", totals: project.telemetry.totals() });
      },
      300,
      (e) => slog.warn("stream.update_failed", { error: String(e) }),
    );
    sse.onClose(harness.subscribeCommits(() => state()));
    sse.onClose(() => state.cancel());
    await state.now();
    void req;
  }

  closeAll(): void {
    this.closing = true;
    // Copy first: closing a stream removes it from the set.
    for (const sse of [...this.open]) sse.close();
  }

  get size(): number {
    return this.open.size;
  }
}
