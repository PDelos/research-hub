// Built-in plugin rh.schedule: the project's scheduler (sweep times, missed runs, requests from the UI).
import { hostOf } from "../../src/kernel/builtin.ts";
import type { PluginContext } from "../../src/kernel/lifecycle.ts";
import { Scheduler } from "../../src/schedule.ts";
import type { CharterExports } from "../rh.charter/main.ts";

export interface ScheduleExports {
  scheduler: Scheduler;
}

export function activate(context: PluginContext): ScheduleExports {
  const host = hostOf(context);
  const { state, charters } = context.exports["rh.charter"] as CharterExports;
  const scheduler = new Scheduler({
    db: host.db,
    settings: host.settings,
    state,
    charters,
    defaults: host.options.schedule,
    log: host.log,
  });
  return { scheduler };
}
