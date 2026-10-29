// The project agent's state for GET /v1/agent and the agent.state frame.
import type { AgentState } from "@rh/sdk";
import type { ProjectRuntime } from "./project.ts";

export async function agentState(project: ProjectRuntime): Promise<AgentState> {
  const { harness, ctx: context } = project.harness;
  const model = await project.model();
  const graph = await harness.taskGraph(context);
  let busy: boolean;
  try {
    busy = Object.values(graph.value.tasks).some(
      (t) => (t.conversationId as number) === (project.root.id as number) && !t.background,
    );
  } finally {
    graph.dispose();
  }
  const compaction = project.compaction();
  return {
    project: project.name,
    conversationId: project.root.id as number,
    model: model.id,
    contextTokens: project.telemetry.contextTokens(project.root.id as number),
    contextWindow: model.window,
    busy,
    compaction: { ...compaction.points, enabled: compaction.enabled, window: compaction.window },
  };
}
