import { spawn, type ChildProcess } from "node:child_process";
import { createOpencodeClient, createOpencodeServer } from "@opencode-ai/sdk/v2";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { UserFacingError } from "./errors.js";
import type { ModelRef, Usage } from "./state/schema.js";

/** A running OpenCode server plus a client bound to the workspace. */
export interface Runtime {
  readonly client: OpencodeClient;
  readonly serverUrl: string;
  readonly directory: string;
  close(): void;
}

/**
 * The SDK returns `{data, error}` rather than throwing. Unwrap once, here, so
 * every call site reads as a normal await and a provider failure cannot be
 * mistaken for an empty result.
 */
async function unwrap<T>(
  promise: Promise<{ data?: T; error?: unknown }>,
  what: string,
): Promise<T> {
  const { data, error } = await promise;
  if (error !== undefined && error !== null) {
    throw new UserFacingError(`OpenCode ${what} failed: ${JSON.stringify(error)}`);
  }
  if (data === undefined) {
    throw new UserFacingError(`OpenCode ${what} returned no data`);
  }
  return data;
}

/**
 * Start a server on an ephemeral port bound to loopback.
 *
 * Port 0 lets the OS choose, so concurrent runs never collide, and the server
 * lives only as long as this process.
 */
export async function startRuntime(
  directory: string,
  config?: Record<string, unknown>,
): Promise<Runtime> {
  // The config is passed to the server rather than left to file discovery:
  // OpenCode resolves project config from its own working directory, so a
  // workspace `opencode.json` is not picked up and its permissions never take
  // effect.
  const server = await createOpencodeServer({
    hostname: "127.0.0.1",
    port: 0,
    ...(config ? { config: config as never } : {}),
  });
  const client = createOpencodeClient({ baseUrl: server.url, directory });
  return {
    client,
    serverUrl: server.url,
    directory,
    close: () => server.close(),
  };
}

export interface AttachedTui {
  readonly process: ChildProcess;
  readonly exited: Promise<number>;
}

/** Attach OpenCode's native terminal UI to the controller-owned server. */
export function tuiAttachArgs(runtime: Pick<Runtime, "serverUrl">, directory: string): string[] {
  return ["attach", runtime.serverUrl, "--dir", directory];
}

export function attachTui(runtime: Runtime, directory: string): AttachedTui {
  const child = spawn(
    "opencode",
    tuiAttachArgs(runtime, directory),
    {
      stdio: "inherit",
      env: process.env,
    },
  );
  const exited = new Promise<number>((resolve) => {
    child.once("error", () => resolve(127));
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 130 : 0)));
  });
  return { process: child, exited };
}

export async function stopTui(tui: AttachedTui): Promise<void> {
  if (tui.process.exitCode === null && tui.process.signalCode === null) {
    tui.process.kill("SIGTERM");
  }
  await tui.exited;
}

/**
 * Create a session.
 *
 * One per stage: paper-run's evaluation traced a 6.7x input-token blowup to a
 * single session carrying 12 of 13 stages, with transcript_messages growing
 * monotonically 8 -> 195. The on-disk artifacts are the cross-stage memory, so
 * a fresh session loses nothing that matters.
 */
export async function createSession(
  runtime: Runtime,
  options: { title: string; agent?: string },
): Promise<string> {
  const session = await unwrap(
    runtime.client.session.create({
      directory: runtime.directory,
      title: options.title,
      ...(options.agent ? { agent: options.agent } : {}),
    }),
    "session.create",
  );
  const id = (session as { id?: string }).id;
  if (!id) throw new UserFacingError("OpenCode session.create returned no session id");
  return id;
}

export interface PromptOptions {
  readonly sessionId: string;
  readonly text: string;
  readonly model?: ModelRef | null;
  readonly agent?: string;
  /** Files to attach; `data:` URIs and `file://` paths are both accepted. */
  readonly files?: readonly { mime: string; url: string; filename?: string }[];
}

/**
 * Send a prompt and return immediately.
 *
 * Completion is detected by `waitForIdle`, never by the model saying it is
 * done, which is the whole point of a validator-driven controller.
 */
export async function prompt(runtime: Runtime, options: PromptOptions): Promise<void> {
  const parts: Array<Record<string, unknown>> = [{ type: "text", text: options.text }];
  for (const file of options.files ?? []) {
    parts.push({
      type: "file",
      mime: file.mime,
      url: file.url,
      ...(file.filename ? { filename: file.filename } : {}),
    });
  }

  await unwrap(
    runtime.client.session.promptAsync({
      sessionID: options.sessionId,
      directory: runtime.directory,
      parts: parts as never,
      ...(options.agent ? { agent: options.agent } : {}),
      ...(options.model
        ? {
            model: { providerID: options.model.providerID, modelID: options.model.modelID },
            ...(options.model.variant ? { variant: options.model.variant } : {}),
          }
        : {}),
    }),
    "session.promptAsync",
  );
}

type StatusKind = "idle" | "busy" | "retry" | "unknown";

/**
 * Read one session's status.
 *
 * On error this reports `busy`, never `idle`: treating a failed status read as
 * "finished" would let the controller validate a half-written workspace and
 * call it a pass.
 */
async function readStatus(runtime: Runtime, sessionId: string): Promise<StatusKind> {
  try {
    const statuses = await unwrap(
      runtime.client.session.status({ directory: runtime.directory }),
      "session.status",
    );
    const entry = (statuses as Record<string, { type?: string } | undefined>)[sessionId];
    // An absent key means idle in some server versions; an explicit
    // `{type:"idle"}` in others. Accept both.
    if (entry === undefined) return "idle";
    if (entry.type === "busy") return "busy";
    if (entry.type === "retry") return "retry";
    if (entry.type === "idle") return "idle";
    return "unknown";
  } catch {
    return "busy";
  }
}

const POLL_INTERVAL_MS = 250;
const BUSY_POLL_INTERVAL_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WaitOptions {
  readonly sessionId: string;
  readonly timeoutMs: number;
  /** How long to wait for the session to pick the prompt up at all. */
  readonly startedWithinMs?: number;
  readonly signal?: AbortSignal;
}

export interface WaitResult {
  /** False when the session never went busy, i.e. the prompt did no work. */
  readonly startedWork: boolean;
}

/**
 * Wait for a session to finish the work a prompt started.
 *
 * `promptAsync` returns before the model begins, so an immediate idle reading
 * means "has not started", not "has finished". Waiting for busy first is what
 * separates the two; without it the controller would validate an untouched
 * workspace and report the stage complete. If the session never goes busy we
 * report that rather than hang, so the caller can fail with a real message
 * instead of a timeout.
 */
export async function waitForIdle(
  runtime: Runtime,
  options: WaitOptions,
): Promise<WaitResult> {
  const deadline = Date.now() + options.timeoutMs;
  const startDeadline = Date.now() + (options.startedWithinMs ?? 30_000);

  let observedBusy = false;
  while (Date.now() < startDeadline) {
    options.signal?.throwIfAborted();
    const status = await readStatus(runtime, options.sessionId);
    if (status === "busy" || status === "retry") {
      observedBusy = true;
      break;
    }
    await sleep(BUSY_POLL_INTERVAL_MS);
  }

  if (!observedBusy) return { startedWork: false };

  while (Date.now() < deadline) {
    options.signal?.throwIfAborted();
    const status = await readStatus(runtime, options.sessionId);
    if (status === "idle") return { startedWork: true };
    await sleep(POLL_INTERVAL_MS);
  }

  throw new UserFacingError(
    `OpenCode session ${options.sessionId} did not go idle within ` +
      `${Math.round(options.timeoutMs / 1000)}s`,
  );
}

/**
 * Cumulative token and cost figures for a session.
 *
 * There is no per-turn delta endpoint, so a per-stage figure is the difference
 * between two snapshots. Reading the whole transcript is O(messages), which is
 * itself a reason to keep sessions per-stage.
 */
export async function sessionUsage(runtime: Runtime, sessionId: string): Promise<Usage> {
  const usage: Usage = {
    model_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost: 0,
    transcript_messages: 0,
  };

  let messages: unknown;
  try {
    messages = await unwrap(
      runtime.client.session.messages({ sessionID: sessionId, directory: runtime.directory }),
      "session.messages",
    );
  } catch {
    // Telemetry must never fail a stage that otherwise succeeded.
    return usage;
  }

  const list = Array.isArray(messages) ? messages : [];
  usage.transcript_messages = list.length;

  for (const entry of list) {
    const info = (entry as { info?: Record<string, unknown> }).info ?? entry;
    const record = info as {
      role?: string;
      cost?: number;
      tokens?: {
        input?: number;
        output?: number;
        reasoning?: number;
        cache?: { read?: number; write?: number };
      };
    };
    if (record.role !== "assistant") continue;
    usage.model_calls += 1;
    usage.input_tokens += record.tokens?.input ?? 0;
    usage.output_tokens += record.tokens?.output ?? 0;
    usage.reasoning_tokens += record.tokens?.reasoning ?? 0;
    usage.cache_read_tokens += record.tokens?.cache?.read ?? 0;
    usage.cache_write_tokens += record.tokens?.cache?.write ?? 0;
    usage.cost += record.cost ?? 0;
  }
  return usage;
}

/** The difference between two snapshots: one stage's own consumption. */
export function usageDelta(before: Usage, after: Usage): Usage {
  const at = (a: number, b: number): number => Math.max(0, b - a);
  return {
    model_calls: at(before.model_calls, after.model_calls),
    input_tokens: at(before.input_tokens, after.input_tokens),
    output_tokens: at(before.output_tokens, after.output_tokens),
    reasoning_tokens: at(before.reasoning_tokens, after.reasoning_tokens),
    cache_read_tokens: at(before.cache_read_tokens, after.cache_read_tokens),
    cache_write_tokens: at(before.cache_write_tokens, after.cache_write_tokens),
    cost: Math.max(0, after.cost - before.cost),
    transcript_messages: after.transcript_messages,
  };
}

/** Read the assistant's last text reply, for logging and diagnostics. */
export async function lastAssistantText(
  runtime: Runtime,
  sessionId: string,
): Promise<string> {
  try {
    const messages = await unwrap(
      runtime.client.session.messages({ sessionID: sessionId, directory: runtime.directory }),
      "session.messages",
    );
    const list = Array.isArray(messages) ? messages : [];
    for (let at = list.length - 1; at >= 0; at -= 1) {
      const entry = list[at] as { info?: { role?: string }; parts?: Array<{ type?: string; text?: string }> };
      if (entry?.info?.role !== "assistant") continue;
      const text = (entry.parts ?? [])
        .filter((part) => part.type === "text" && part.text)
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (text) return text;
    }
  } catch {
    return "";
  }
  return "";
}

export interface PermissionAsk {
  readonly permissionId: string;
  readonly sessionId: string;
  readonly action: string;
  readonly resources: string[];
}

/**
 * Watch for permission requests and report the first one.
 *
 * A headless run has nobody to answer a prompt, so the session simply stays
 * busy until the stage budget expires. That is a 30-minute wait to learn
 * something the server knew in the first second, and the resulting "did not go
 * idle" error names the wrong cause. This turns it into an immediate, accurate
 * failure.
 *
 * Returns a stop function; the promise resolves with the first ask seen, or
 * never resolves if none occurs.
 */
export function watchPermissionAsks(runtime: Runtime): {
  first: Promise<PermissionAsk>;
  stop: () => void;
} {
  let stopped = false;
  let resolveFirst: (ask: PermissionAsk) => void = () => {};
  const first = new Promise<PermissionAsk>((resolve) => {
    resolveFirst = resolve;
  });

  void (async () => {
    try {
      const events = await runtime.client.event.subscribe();
      for await (const event of events.stream as AsyncIterable<{
        type?: string;
        data?: { id?: string; sessionID?: string; action?: string; resources?: string[] };
      }>) {
        if (stopped) return;
        if (event.type !== "permission.asked" && event.type !== "permission.v2.asked") continue;
        resolveFirst({
          permissionId: event.data?.id ?? "unknown",
          sessionId: event.data?.sessionID ?? "unknown",
          action: event.data?.action ?? "unknown",
          resources: event.data?.resources ?? [],
        });
        return;
      }
    } catch {
      // A dropped stream must not fail a run; the budget remains the backstop.
    }
  })();

  return { first, stop: () => { stopped = true; } };
}
