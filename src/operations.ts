import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, writeFileSync } from "node:fs";
import { dirname, extname, parse, resolve } from "node:path";
import { z } from "zod";
import { extractData, isSensitive } from "./input-extraction.js";
import { STAGES, type StageId } from "./stages.js";
import { UserFacingError } from "./errors.js";

const relativePath = z.string().min(1).max(512).refine(value =>
  !value.includes("\\") && !/[\x00-\x1f]/.test(value) &&
  value.split("/").every(part => part !== "" && part !== "." && part !== "..") &&
  !value.includes(":") && !isSensitive(value), "Unsafe path");
const inputPath = relativePath.refine(value => value.startsWith("source/") || value.startsWith(".brain/input/"), "Input must be admitted source or normalized input");
const outputPath = relativePath.refine(value =>
  /^\.brain\/raw\/(?:operations\/|(?:references\.bib|candidates\.json|citation_map\.json|query_plan\.json|build\.json|data_analysis\.json|plotting_results\.json)$)/.test(value) ||
  /^\.brain\/manuscript\/(?:figures\/|tables\/|(?:raw_draft\.tex|final_paper\.(?:tex|pdf)|review\.json)$)/.test(value) ||
  value.startsWith("submission/"), "Output is not controller-whitelisted");

/** No commands, executable code, arbitrary options, or arbitrary filesystem paths. */
export const OperationRequestSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  operation: z.enum(["read", "extract", "analyze", "retrieve", "render", "revise", "build", "review"]),
  target_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/).optional(),
  inputs: z.array(inputPath).max(16),
  parameters: z.object({
    // Read offsets and lengths are bytes, not line numbers. Extract is bounded
    // by extractData itself and accepts no slicing parameters.
    offset: z.number().int().min(0).max(64 * 1024 * 1024).optional(),
    length: z.number().int().min(1).max(60000).optional(),
    group_by: z.string().min(1).max(128).optional(),
    value_column: z.string().min(1).max(128).optional(),
    aggregation: z.enum(["count", "min", "max", "mean", "sum"]).optional(),
    query: z.string().min(1).max(2000).optional(),
    instructions: z.string().min(1).max(8000).optional(),
  }).strict(),
}).strict().superRefine((request, ctx) => {
  const allowed: Record<string, string[]> = {
    read: ["offset", "length"], extract: [], analyze: ["group_by", "value_column", "aggregation"],
    retrieve: ["query"], render: ["instructions"], revise: ["instructions"], build: [], review: ["instructions"],
  };
  for (const key of Object.keys(request.parameters)) {
    if (!allowed[request.operation]!.includes(key))
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["parameters", key], message: "Parameter is not supported by this operation" });
  }
  if (["read", "extract", "analyze"].includes(request.operation) && request.inputs.length !== 1)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Native data operations require exactly one input path" });
  if (request.operation === "analyze" && (!request.parameters.aggregation ||
    (request.parameters.aggregation !== "count" && !request.parameters.value_column)))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Analyze requires aggregation and a value_column unless counting" });
});

export type OperationRequest = z.infer<typeof OperationRequestSchema>;
export type OperationHandler = (context: { request: OperationRequest; workspace: string; stage: StageId }) => Promise<{ outputs: string[]; detail: string }>;
export type OperationHandlers = Partial<Record<OperationRequest["operation"], OperationHandler>>;
const RecordSchema = z.object({
  id: z.string(), stage: z.enum(STAGES), request: OperationRequestSchema,
  status: z.enum(["queued", "running", "completed", "failed", "blocked"]),
  input_digest: z.string(), outputs: z.array(outputPath).max(32),
  output_digests: z.record(z.string()), error: z.string().nullable(),
  attempts: z.number().int().nonnegative(), detail: z.string().max(64000).default(""),
}).strict();
export type OperationRecord = z.infer<typeof RecordSchema>;
const RegistrySchema = z.object({ version: z.literal(1), records: z.array(RecordSchema).max(4096) }).strict();
const MAX_FILE = 64 * 1024 * 1024;

// Inspect ancestors too: checking only the final file misses linked .brain roots.
function checkedPath(workspace: string, rel: string): string {
  relativePath.parse(rel);
  const target = resolve(workspace, rel);
  let current = parse(target).root;
  const parts = target.slice(current.length).split("/");
  for (const [index, part] of parts.entries()) {
    current = resolve(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw new Error("Unsafe filesystem entry");
      if (stat.isFile() && stat.nlink !== 1) throw new Error("Hard-linked file refused");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return target;
}

function boundedRead(workspace: string, rel: string, limit = MAX_FILE): Buffer {
  const fd = openSync(checkedPath(workspace, rel), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new Error("File exceeds safe read limit");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error("Input changed while reading");
      offset += count;
    }
    return bytes;
  } finally { closeSync(fd); }
}

function inputDigest(workspace: string, request: OperationRequest): string {
  // Prepared workspaces record exclusions as well as admitted inputs. Never let
  // a request turn an excluded/unknown original into newly admitted evidence.
  let manifest: Array<{ source: string; imported?: string; normalized?: string; role: string; status: string }> | undefined;
  if (request.inputs.length) {
    try {
      manifest = z.array(z.object({ source: z.string(), imported: z.string().optional(), normalized: z.string().optional(),
        role: z.string(), status: z.string() })).parse(JSON.parse(boundedRead(workspace, ".brain/input-manifest.json", 16 * 1024 * 1024).toString("utf8")));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Unsafe admission manifest"); }
  }
  return hash(JSON.stringify([request, request.inputs.map(path => {
    if (manifest && !manifest.some(entry => (entry.role === "research" ||
      (entry.role === "figure" && !["read", "extract", "analyze"].includes(request.operation))) && entry.status !== "excluded" &&
      (path === `source/${entry.imported ?? entry.source}` || path === entry.normalized))) throw new Error("Input is not admitted research material");
    return hash(boundedRead(workspace, path));
  })]));
}

function persist(workspace: string, rel: string, value: unknown): void {
  const target = checkedPath(workspace, rel);
  mkdirSync(dirname(target), { recursive: true });
  checkedPath(workspace, rel);
  const tmp = `${target}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  renameSync(tmp, target);
}

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

// Never echo parser/subprocess exceptions or unsanitized source text into logs.
function redact(text: string): string {
  return text.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]+|AKIA[A-Z0-9]{16})\b/g, "[REDACTED]")
    .replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret|authorization)["']?\s*[:=]\s*)[^\r\n,}]+/gi, "$1[REDACTED]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]");
}

/** Bounded RFC-style records, including quoted delimiters/newlines and escaped quotes. */
function delimitedRows(text: string, delimiter: string): Record<string, string>[] {
  const records: string[][] = [];
  let row: string[] = [], cell = "", quoted = false, closed = false;
  const finishCell = () => {
    row.push(cell); cell = ""; closed = false;
    if (row.length > 64) throw new Error("Analysis exceeds 64 columns");
  };
  const finishRow = () => {
    // Ignore empty physical lines, but retain explicit empty delimited rows.
    if (row.length > 1 || row[0] !== "") records.push(row);
    row = [];
    if (records.length > 100001) throw new Error("Analysis exceeds 100000 data rows");
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char !== '"') cell += char;
      else if (text[index + 1] === '"') { cell += '"'; index++; }
      else { quoted = false; closed = true; }
    } else if (char === delimiter) finishCell();
    else if (char === "\n" || char === "\r") {
      finishCell(); finishRow();
      if (char === "\r" && text[index + 1] === "\n") index++;
    } else if (char === '"' && !cell && !closed) quoted = true;
    else {
      if (closed || char === '"') throw new Error("Malformed quoted field");
      cell += char;
    }
  }
  if (quoted) throw new Error("Unterminated quoted field");
  if (cell || row.length || closed) { finishCell(); finishRow(); }
  const headers = records.shift()?.map(header => header.trim()) ?? [];
  if (!headers.length || headers.some(header => !header) || new Set(headers).size !== headers.length)
    throw new Error("Table requires unique nonempty headers");
  return records.map(values => {
    if (values.length !== headers.length) throw new Error("Row does not match headers");
    return Object.fromEntries(headers.map((header, index) => [header, values[index]!]));
  });
}

async function nativeData({ request, workspace, stage }: Parameters<OperationHandler>[0]): ReturnType<OperationHandler> {
  const rel = request.inputs[0]!;
  const bytes = boundedRead(workspace, rel);
  let detail: string;
  if (request.operation === "read") {
    if (![".txt", ".md", ".csv", ".tsv", ".json", ".jsonl", ".ndjson", ".log", ".tex", ".py", ".r", ".yaml", ".yml", ".toml"].includes(extname(rel).toLowerCase()) || bytes.includes(0))
      throw new Error("Unsupported text input");
    const offset = request.parameters.offset ?? 0;
    detail = redact(bytes.subarray(offset, offset + (request.parameters.length ?? 16384)).toString("utf8"));
  } else if (request.operation === "extract") {
    checkedPath(workspace, rel);
    detail = redact(await extractData(workspace, rel));
  } else {
    const extension = extname(rel).toLowerCase();
    if (![".json", ".csv", ".tsv"].includes(extension) || bytes.length > 2 * 1024 * 1024) throw new Error("Analysis supports bounded JSON/CSV/TSV rows only");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
    const rows: unknown = extension === ".json" ? JSON.parse(text) : delimitedRows(text, extension === ".tsv" ? "\t" : ",");
    if (!Array.isArray(rows) || rows.length > 100000) throw new Error("Expected at most 100000 rows");
    const { group_by, value_column, aggregation } = request.parameters;
    if ([group_by, value_column].some(key => key && isSensitive(key))) throw new Error("Sensitive column refused");
    const groups = new Map<string, number[]>();
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).length > 64) throw new Error("Expected object rows with at most 64 columns");
      const label = group_by && Object.hasOwn(row, group_by) ? row[group_by] : group_by ? undefined : "all";
      if (typeof label !== "string" && typeof label !== "number") throw new Error("Missing scalar group label");
      const key = String(label);
      if (key.length > 256) throw new Error("Group label exceeds limit");
      const values = groups.get(key) ?? [];
      const raw = aggregation === "count" ? 1 : Object.hasOwn(row, value_column!) ? row[value_column!] : undefined;
      const value = typeof raw === "string" && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw.trim()) ? Number(raw) : raw;
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Missing finite numeric value");
      values.push(value); groups.set(key, values);
      if (groups.size > 200) throw new Error("Too many groups");
    }
    detail = redact(JSON.stringify({ procedure: "Complete selected JSON/CSV/TSV rows; no experiments executed", source: rel,
      aggregation, group_by, value_column, rows: rows.length,
      groups: [...groups].map(([group, values]) => ({ group, count: values.length, value:
        aggregation === "count" ? values.length : aggregation === "min" ? values.reduce((a, b) => Math.min(a, b)) :
        aggregation === "max" ? values.reduce((a, b) => Math.max(a, b)) :
        values.reduce((a, b) => a + (aggregation === "mean" ? b / values.length : b), 0) })) }, (_, value) => {
      if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Numeric overflow");
      return value;
    }));
  }
  const output = `.brain/raw/operations/${stage}/${request.id}.json`;
  persist(workspace, output, { id: request.id, stage, source: rel, detail });
  return { outputs: [output], detail };
}

/** Call serially after each model turn. Handlers are trusted controller code, not a sandbox. */
export async function executeOperations(options: {
  workspace: string; stage: StageId; onEvent?: (line: string) => void; handlers?: OperationHandlers;
  maxRequests?: number; maxExecutions?: number; maxAttempts?: number;
  beforeDispatch?: () => void;
}): Promise<{ executed: number; pending: number; errors: string[] }> {
  const { workspace, stage, handlers = {} } = options;
  z.enum(STAGES).parse(stage);
  const maxRequests = z.number().int().min(1).max(64).parse(options.maxRequests ?? 64);
  const maxExecutions = z.number().int().min(0).max(64).parse(options.maxExecutions ?? 64);
  const maxAttempts = z.number().int().min(1).max(100).parse(options.maxAttempts ?? 3);
  const errors: string[] = [];
  let executed = 0;
  let registry: z.infer<typeof RegistrySchema> = { version: 1, records: [] };
  try { registry = RegistrySchema.parse(JSON.parse(boundedRead(workspace, ".po-run/operations.json", 16 * 1024 * 1024).toString("utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Operation registry is unsafe or invalid; refusing to overwrite it"); }
  for (const record of registry.records) {
    if (record.id !== record.request.id) throw new Error("Operation registry identity mismatch");
    if (record.status === "running") record.status = "queued";
  }
  const keys = registry.records.map(record => `${record.stage}/${record.id}`);
  if (new Set(keys).size !== keys.length) throw new Error("Duplicate operation registry identity");
  const save = () => {
    persist(workspace, ".po-run/operations.json", registry);
    persist(workspace, ".brain/operation-results.json", { version: 1, stage,
      records: registry.records.map(({ request: _request, ...record }) => record), errors });
  };
  const conflicts = new Set<string>();
  const requested = new Set<string>();
  try {
    const requests = z.array(OperationRequestSchema).max(maxRequests).parse(JSON.parse(boundedRead(workspace, ".brain/requests.json", 1024 * 1024).toString("utf8")));
    for (const request of requests) {
      requested.add(request.id);
      const previous = registry.records.find(record => record.stage === stage && record.id === request.id);
      if (previous) {
        if (JSON.stringify(previous.request) !== JSON.stringify(request)) {
          errors.push(`${request.id}: conflicting request for existing stage/id`); conflicts.add(request.id);
        }
      } else if (registry.records.length >= 4096) errors.push(`${request.id}: registry capacity reached`);
      else registry.records.push({ id: request.id, stage, request, status: "queued", input_digest: "", outputs: [], output_digests: {}, error: null, attempts: 0, detail: "" });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push("Request file is unsafe, invalid, or exceeds the per-turn limit");
  }
  save();
  for (const record of registry.records.filter(record => record.stage === stage && requested.has(record.id))) {
    if (conflicts.has(record.id)) continue;
    try {
      const request = record.request;
      const digest = inputDigest(workspace, request);
      let unchanged = record.status === "completed" && record.input_digest === digest && record.outputs.length > 0;
      if (unchanged) {
        try { unchanged = record.outputs.every(path => record.output_digests[path] === hash(boundedRead(workspace, path))); }
        catch { unchanged = false; }
      }
      if (unchanged) continue;
      record.status = "queued"; record.error = null;
      if (record.attempts >= maxAttempts) { record.status = "blocked"; record.error = "Attempt limit reached; issue a new id for an intentional retry"; }
      else if (executed >= maxExecutions) continue;
      else {
        const handler = handlers[request.operation] ?? (["read", "extract", "analyze"].includes(request.operation) ? nativeData : undefined);
        if (!handler) { record.status = "blocked"; record.error = `No controller handler registered for ${request.operation}`; }
        else {
          options.beforeDispatch?.();
          record.status = "running"; record.input_digest = digest; record.attempts++; executed++;
          save();
          let result: Awaited<ReturnType<OperationHandler>>;
          try {
            result = await handler({ request, workspace, stage });
          } finally {
            // A scoped render can itself ask for data during a model turn.
            // Retain those serial nested dispatches instead of overwriting them
            // with the parent invocation's pre-handler registry snapshot.
            const latest = RegistrySchema.parse(JSON.parse(boundedRead(workspace, ".po-run/operations.json", 16 * 1024 * 1024).toString("utf8")));
            for (const nested of latest.records) {
              if (nested.stage === record.stage && nested.id === record.id) continue;
              const existing = registry.records.find(item => item.stage === nested.stage && item.id === nested.id);
              if (existing) Object.assign(existing, nested);
              else registry.records.push(nested);
            }
          }
          const outputs = z.array(outputPath).min(1).max(32).parse(result.outputs);
          const digests = Object.fromEntries(outputs.map(path => [path, hash(boundedRead(workspace, path))]));
          if (digest !== inputDigest(workspace, request)) throw new Error("Input changed during execution");
          record.outputs = outputs; record.output_digests = digests;
          record.detail = redact(z.string().max(64000).parse(result.detail)); record.status = "completed";
        }
      }
    } catch (error) {
      record.status = "failed"; record.error = "Operation failed: unsafe or unsupported input/output, handler failure, or exceeded limits";
      if (error instanceof UserFacingError) record.detail = redact(error.message).slice(0, 64000);
    }
    if (record.error) errors.push(`${record.id}: ${record.error}`);
    save();
    try { options.onEvent?.(`operation ${stage}/${record.id}: ${record.status}`); } catch { /* Observers cannot change task outcomes. */ }
  }
  save();
  return { executed, pending: registry.records.filter(record => record.stage === stage && requested.has(record.id) && record.status !== "completed").length, errors };
}
