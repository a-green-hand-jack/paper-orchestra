import { checkpointHistory } from "../checkpoints.js";
import { formatModelRef } from "../model.js";
import { STAGES, TITLES, stageNumber, type StageId } from "../stages.js";
import type { RunState } from "../state/schema.js";
import { readRunState, readSessionState, resumeStage } from "../state/store.js";

const GLYPHS: Record<string, string> = {
  pending: ".",
  running: ">",
  gate_waiting: "?",
  failed: "x",
  interrupted: "-",
  completed: "+",
};

export interface StatusReport {
  readonly run_id: string;
  readonly status: string;
  readonly mode: string;
  readonly venue: string;
  readonly use_plotting: boolean;
  readonly default_model: string;
  readonly next_stage: StageId | null;
  readonly stages: Array<{
    id: StageId;
    number: number;
    status: string;
    attempts: number;
    notes: string;
    error: string | null;
    model: string;
  }>;
  readonly totals: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cost: number;
  };
  readonly checkpoints: number;
}

export function buildStatus(state: RunState, checkpoints: number): StatusReport {
  const totals = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost: 0 };
  for (const id of STAGES) {
    const usage = state.stages[id].usage;
    if (!usage) continue;
    totals.input_tokens += usage.input_tokens;
    totals.output_tokens += usage.output_tokens;
    totals.cache_read_tokens += usage.cache_read_tokens;
    totals.cost += usage.cost;
  }

  return {
    run_id: state.run_id,
    status: state.status,
    mode: state.mode,
    venue: state.scope.venue,
    use_plotting: state.scope.use_plotting,
    default_model: formatModelRef(state.default_model),
    next_stage: resumeStage(state),
    stages: STAGES.map((id) => {
      const stage = state.stages[id];
      return {
        id,
        number: stageNumber(id),
        status: stage.status,
        attempts: stage.attempts,
        notes: stage.notes,
        error: stage.error,
        model: formatModelRef(stage.model),
      };
    }),
    totals,
    checkpoints,
  };
}

function renderStatus(report: StatusReport): string {
  const lines: string[] = [];
  lines.push(`run      ${report.run_id}  [${report.status}]  ${report.mode}`);
  lines.push(
    `config   venue=${report.venue}  plotting=${report.use_plotting}  model=${report.default_model}`,
  );
  lines.push("");

  for (const stage of report.stages) {
    const glyph = GLYPHS[stage.status] ?? "?";
    const attempts = stage.attempts > 0 ? ` (attempt ${stage.attempts})` : "";
    lines.push(
      `  ${glyph} ${stage.number}/${report.stages.length} ${TITLES[stage.id].padEnd(18)} ${stage.status}${attempts}`,
    );
    if (stage.notes) lines.push(`      ${stage.notes}`);
    if (stage.error) lines.push(`      error: ${stage.error}`);
  }

  lines.push("");
  if (report.next_stage) {
    lines.push(`next     ${report.next_stage}`);
  } else {
    lines.push("next     none - every stage in the plan is complete");
  }
  lines.push(`ckpts    ${report.checkpoints}`);
  if (report.totals.input_tokens > 0) {
    lines.push(
      `usage    in=${report.totals.input_tokens} out=${report.totals.output_tokens} ` +
        `cache_read=${report.totals.cache_read_tokens} cost=${report.totals.cost.toFixed(4)}`,
    );
  }
  return lines.join("\n");
}

export async function statusCommand(workspace: string, asJson: boolean): Promise<void> {
  const state = readRunState(workspace);
  const history = await checkpointHistory(workspace);
  const report = buildStatus(state, history.length);

  if (asJson) {
    const session = readSessionState(workspace);
    process.stdout.write(
      `${JSON.stringify({ ...report, session: session ? { server_url: session.server_url, sessions: session.sessions } : null }, null, 2)}\n`,
    );
    return;
  }
  process.stdout.write(`${renderStatus(report)}\n`);
}
