// Built-in plugin rh.decision-jev: Jev answers the hub's structured questions through versioned commands, each call
// recorded in the Jev ledger (telemetry). Other built-ins use `decide` and the ledger directly; plugins use
// `rh.decisions.decide(command, vars)` for any Jev command an enabled plugin contributes.
import { dirname, join } from "node:path";
import { JevLedger, loadCommand, runCommand, type Decide } from "@rh/jev";
import type { DecisionsService } from "../../src/kernel/api.ts";
import { hostOf } from "../../src/kernel/builtin.ts";
import type { PluginContext } from "../../src/kernel/lifecycle.ts";

export interface PingResult {
  provider: string;
  model: string;
  elapsedMs: number;
  cost: { amount: number | null; source: string };
  greeting: number;
}

export interface DecisionExports {
  decide: Decide;
  ledger: JevLedger;
  /** The v0 commands folder (prompt_engineering/jev). */
  jevDir: string;
  /** Run the `ping` command and record it. */
  ping(text?: string): Promise<PingResult>;
}

export function activate(context: PluginContext): DecisionExports {
  const host = hostOf(context);
  const { options } = host;
  const decide: Decide = options.decide ?? ((state, questions, o) => options.jev.systemOne(state, questions, o));
  const ledger = new JevLedger((record) => host.telemetry.jevCall(record));
  const jevDir = join(options.promptsDir, "jev");

  const decisions: DecisionsService = {
    async decide(command, vars) {
      const folder = host.services.contributions.jevCommands().get(command);
      if (!folder) throw new Error(`no enabled plugin contributes the Jev command ${command}`);
      const cmd = loadCommand(command, dirname(folder));
      try {
        const { result } = await runCommand(cmd, vars, decide);
        ledger.record(result, { command: cmd.name, version: cmd.version, extra: { plugin: context.id } });
        return { answers: result.answers as Record<string, unknown>, costUsd: result.meta.cost.amount ?? 0 };
      } catch (error) {
        ledger.fail(error, { command: cmd.name, version: cmd.version, questions: Object.keys(cmd.questions).length });
        throw error;
      }
    },
  };
  host.services.providers.decisions = decisions;
  context.subscriptions.push({
    dispose: () => {
      if (host.services.providers.decisions === decisions) host.services.providers.decisions = undefined;
    },
  });

  return {
    decide,
    ledger,
    jevDir,
    async ping(text = "Good morning, research desk!") {
      const cmd = loadCommand("ping", jevDir);
      try {
        const { result } = await runCommand(cmd, { text }, decide);
        ledger.record(result, { command: cmd.name, version: cmd.version });
        const answer = result.answers.greeting as { noul: number };
        return {
          provider: result.meta.provider,
          model: result.meta.resolvedModel,
          elapsedMs: result.meta.elapsedMs,
          cost: result.meta.cost,
          greeting: answer.noul,
        };
      } catch (error) {
        ledger.fail(error, { command: cmd.name, version: cmd.version, questions: 1 });
        throw error;
      }
    },
  };
}
