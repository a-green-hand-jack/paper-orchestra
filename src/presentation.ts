import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ZodError } from "zod";
import { OutlineSchema, TABLE_VERIFICATION_HELP, type ColumnVerification, type TableSpec } from "./artifacts.js";
import { assertInside, digestFile, digestValue, ensureDir, readJson, walkFiles, writeJsonAtomic } from "./files.js";
import { ARTIFACTS, paths } from "./paths.js";
import type { Check } from "./state/schema.js";
import { z } from "zod";
import { isLatexDependency } from "./latexbuild.js";

const TABLES = ".brain/manuscript/tables";

const NUMBER = /[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/g;
const LOG_NUMBER = /(?<![A-Za-z0-9_.+-])[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?(?![A-Za-z0-9_.])/g;

function numeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

/** RFC-style quoted cells, including embedded delimiters/newlines and doubled quotes. */
function csvRecords(text: string, delimiter: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char !== '"') cell += char;
      else if (text[i + 1] === '"') { cell += '"'; i++; }
      else { quoted = false; closed = true; }
    } else if (char === delimiter || char === "\n" || char === "\r") {
      row.push(cell); cell = ""; closed = false;
      if (char !== delimiter) {
        if (row.some((value) => value.length)) rows.push(row);
        row = [];
        if (char === "\r" && text[i + 1] === "\n") i++;
      }
    } else if (char === '"' && !cell && !closed) quoted = true;
    else {
      if (closed || char === '"') throw new Error("Malformed quoted CSV cell");
      cell += char;
    }
  }
  if (quoted) throw new Error("Unterminated quoted CSV cell");
  if (cell || row.length || closed) rows.push([...row, cell]);
  const headers = rows.shift()?.map((header) => header.trim()) ?? [];
  if (!headers.length || headers.some((header) => !header) || new Set(headers).size !== headers.length) throw new Error("CSV needs unique nonempty headers");
  return rows.map((values) => {
    if (values.length !== headers.length) throw new Error("CSV row does not match headers");
    return Object.fromEntries(headers.map((header, index) => [header, values[index]!]));
  });
}

/** Small raw tables are analyzed mechanically, without executing repository code. */
export function analyzeSourceTables(workspace: string): void {
  const source = paths(workspace).source;
  const files: Array<Record<string, unknown>> = [];
  const loaded: Array<{ path: string; rows: Record<string, string>[] }> = [];
  for (const rel of walkFiles(source).filter((rel) => /\.(csv|tsv)$/i.test(rel))) {
    const path = safeFile(source, rel);
    if (statSync(path).size > 2 * 1024 * 1024 || loaded.length >= 32) {
      files.push({ source: `source/${rel}`, status: "skipped", reason: "bounded analysis: 2 MiB per file, 32 files" });
      continue;
    }
    try {
      const rows = csvRecords(readFileSync(path, "utf8").replace(/^\uFEFF/, ""), rel.endsWith(".tsv") ? "\t" : ",");
      const columns = Object.keys(rows[0] ?? {});
      if (columns.length > 64 || rows.length > 100000) throw new Error("bounded analysis: 64 columns, 100000 rows");
      loaded.push({ path: `source/${rel}`, rows });
      const stats = (subset: Record<string, string>[]) => Object.fromEntries(columns.flatMap((column) => {
        const values = subset.map((row) => numeric(row[column])).filter((value): value is number => value !== null);
        if (!values.length) return [];
        return [[column, { count: values.length, min: values.reduce((a, b) => Math.min(a, b)),
          max: values.reduce((a, b) => Math.max(a, b)), mean: values.reduce((a, b) => a + b / values.length, 0) }]];
      }));
      const groups: Array<{ column: string; value: string; rows: number; statistics: ReturnType<typeof stats> }> = [];
      for (const column of columns) {
        const labels = [...new Set(rows.map((row) => row[column]!))];
        if (!labels.length || labels.length > 20 || labels.every((value) => numeric(value) !== null)) continue;
        for (const value of labels) {
          const selected = rows.filter((row) => row[column] === value);
          groups.push({ column, value, rows: selected.length, statistics: stats(selected) });
        }
      }
      files.push({ source: `source/${rel}`, source_sha256: digestFile(path), status: "computed",
        rows: rows.length, statistics: stats(rows), groups });
    } catch (error) {
      files.push({ source: `source/${rel}`, status: "unreadable", reason: String(error) });
    }
  }
  const crossChecks: Array<Record<string, unknown>> = [];
  for (const file of files) {
    if (!Array.isArray(file.groups)) continue;
    for (const group of file.groups as Array<{column: string; value: string; statistics: Record<string, {min: number; max: number}>}>) {
      for (const other of loaded.filter((entry) => entry.path !== file.source)) {
        for (const row of other.rows.filter((entry) => entry[group.column] === group.value)) {
          for (const [field, text] of Object.entries(row)) {
            const match = /^(min|max)_(.+)$/.exec(field);
            const reported = numeric(text);
            if (!match || reported === null || !group.statistics[match[2]!]) continue;
            const operation = match[1] as "min" | "max";
            const computed = group.statistics[match[2]!]![operation];
            crossChecks.push({ source: file.source, against: other.path, group: group.value,
              column: match[2], operation, computed, reported,
              matches: Math.abs(computed - reported) <= 1e-12 * Math.max(1, Math.abs(reported)) });
          }
        }
      }
    }
  }
  writeJsonAtomic(join(workspace, ".brain/raw/data_analysis.json"), {
    version: 1, executor: "paper-orchestra controller", computed_at: new Date().toISOString(),
    procedure: "Numeric column counts, extrema and means over complete small CSV/TSV files; categorical groups with at most 20 labels; matching min_/max_ summary columns cross-checked by group.",
    files, cross_checks: crossChecks,
  });
}

function verifyTableNumbers(table: TableSpec, sourceFiles: Map<string, string>) {
  const cache = new Map<string, unknown>();
  const logLines = new Map<string, string[]>();
  type TextSource = { path: string; line: number; prefix: string; index: number; token: string };
  const checks: Array<{ row: number; column: number; operation: string; selectors: string[]; expected: number[]; text_source?: TextSource }> = [];
  const declared = table.column_verification;
  const calculation = table.calculation.toLowerCase();
  const hasCalculation = calculation.trim().length > 0 && !/^(?:none|direct|verbatim|no calculations?)[.!]?$/.test(calculation.trim());
  const described = {
    min: /\bmin(?:imum)?\b/.test(calculation), max: /\bmax(?:imum)?\b/.test(calculation),
    mean: /\b(?:mean|average)\b/.test(calculation), std: /\b(?:std|standard deviation)\b/.test(calculation),
    range: /\brange\b/.test(calculation),
  };
  const describedDecimals = /\b(?:round(?:ed|ing)?(?:\s+to)?\s+)(\d+)\s*(?:decimal(?:s| places)?|digits)\b/.exec(calculation)?.[1];
  const norm = (value: string) => value.toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, "").replace(/[^a-z0-9]/g, "");
  for (const [rowIndex, row] of table.rows.entries()) {
    const groups = new Map<string, unknown[]>();
    const documents: unknown[] = [];
    for (const source of row.source_paths) {
      const file = sourceFiles.get(source)!;
      if (!/\.(json|csv|tsv)$/i.test(source)) continue;
      if (!cache.has(source)) {
        if (statSync(file).size > 32 * 1024 * 1024) throw new Error(`Unverifiable table ${table.table_id}: structured input ${source} exceeds 32 MiB; supply a scoped structured input`);
        const text = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
        cache.set(source, /\.json$/i.test(source) ? JSON.parse(text) : csvRecords(text, /\.tsv$/i.test(source) ? "\t" : ","));
      }
      documents.push(cache.get(source));
      const walk = (value: unknown, pointer: string) => {
        if (Array.isArray(value)) {
          const matching = value.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry) &&
            Object.values(entry).some((label) => typeof label === "string" && label === row.label));
          (matching.length ? matching : value).forEach((entry) => walk(entry, `${pointer}/*`));
        }
        else if (value && typeof value === "object") Object.entries(value).forEach(([key, entry]) =>
          walk(entry, `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`));
        else {
          if (!groups.has(pointer)) groups.set(pointer, []);
          groups.get(pointer)!.push(value);
        }
      };
      walk(cache.get(source), "");
    }
    for (const [column, value] of row.values.entries()) {
      if (value === null) continue;
      const text = String(value).trim();
      const tokens = text.match(NUMBER) ?? [];
      if (!tokens.length) continue; // Pure text is checked by content review, not numeric provenance.
      const fail = (reason: string): never => { throw new Error(`Unverifiable table ${table.table_id}, row ${rowIndex + 1} (${row.label}), column ${column + 1} (${table.columns[column]}): ${reason}. ${TABLE_VERIFICATION_HELP} For std, specify ddof (0 population / 1 sample).`); };
      const separators = text.replace(NUMBER, "#").replace(/[()%]/g, "").trim();
      const range = /^#\s*(?:to|[-\u2013\u2014])\s*#$/.test(separators);
      const meanStd = /^#\s*(?:\+\/-|\u00b1)\s*#$/.test(separators);
      if (separators !== "#" && !range && !meanStd) fail("numeric text must be a number, range, or mean +/- std; arbitrary prose/transforms cannot be verified");
      let spec: ColumnVerification | null | undefined = row.cell_verification?.[column] ?? declared?.[column];
      // A direct log selector verifies the recorded field, not the derivation described in prose.
      if (!(spec?.operation === "direct" && spec.selector?.startsWith("text:")) && hasCalculation && (/\b(?:weighted|geometric|harmonic|median|normaliz\w*|normalis\w*|scal\w*|convert\w*|ratio|percentile|bootstrap|sum|difference|subtract\w*|multipl\w*|divid\w*|square\w*|absolute|confidence|twice|add\w*)\b/.test(calculation) ||
          /\blog(?:arithm\w*)?\s*(?:\(|of\b)/.test(calculation))) fail("calculation describes an unsupported transform");
      if (!spec) {
        if (hasCalculation) {
          // Natural-language recognition is deliberately a small grammar. Unrecognized prose
          // requires explicit metadata, rather than treating any sentence containing 'mean' as a mean.
          let residual = calculation;
          for (const key of groups.keys()) {
            for (const segment of key.split("/").filter((part) => part && part !== "*")) {
              const field = segment.replace(/~1/g, "/").replace(/~0/g, "~").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
              residual = residual.replace(new RegExp(`\\b${field}\\b`, "gi"), " ");
            }
          }
          residual = residual.replace(/\b(?:compute|computed|calculate|calculated|report|reported|the|a|an|of|for|from|over|across|all|each|per|and|or|to|in|with|using|as|on|observed|recorded|measurement|measurements|value|values|result|results|run|runs|column|columns|min|minimum|max|maximum|mean|average|std|standard|deviation|range|population|sample|ddof|round|rounded|rounding|decimal|decimals|place|places|digits)\b/g, "");
          if (/[a-z]/i.test(residual)) fail("calculation description is ambiguous or unsupported; use explicit column_verification metadata");
        }
        const heading = table.columns[column]!.toLowerCase();
        let operation: ColumnVerification["operation"] = range ? "range" : meanStd ? "mean_std" : "direct";
        const ops = Object.entries(described).filter(([key, present]) => present &&
          (key === "std" ? /\b(?:std|standard deviation)\b/.test(heading) : new RegExp(`\\b${key === "mean" ? "(?:mean|average)" : key === "min" ? "min(?:imum)?" : key === "max" ? "max(?:imum)?" : key}\\b`).test(heading)))
          .map(([key]) => key as ColumnVerification["operation"]);
        if (!range && !meanStd && ops.length === 1) operation = ops[0]!;
        else if (!range && !meanStd && hasCalculation && Object.values(described).filter(Boolean).length === 1) {
          operation = Object.entries(described).find(([, present]) => present)![0] as ColumnVerification["operation"];
        }
        if (hasCalculation && operation === "direct" && describedDecimals === undefined) fail("calculation is ambiguous or unsupported; no arbitrary transform is inferred");
        spec = { operation, ...(describedDecimals === undefined ? {} : { decimals: Number(describedDecimals) }),
          ...(/\bpopulation\b|ddof\s*=\s*0/.test(calculation) ? { ddof: 0 as const } :
            /\bsample\b|ddof\s*=\s*1/.test(calculation) ? { ddof: 1 as const } : {}) };
      }
      if (spec.decimals !== undefined && spec.decimals > 100) fail("rounding precision exceeds 100 decimal places");
      const numericGroups = [...groups].filter(([, entries]) => entries.some((entry) => numeric(entry) !== null));
      let selected = spec.selector ? numericGroups.filter(([key]) => key === spec.selector ||
        (!spec.selector!.startsWith("/") && key.split("/").at(-1)?.replace(/~1/g, "/").replace(/~0/g, "~") === spec.selector)) :
        numericGroups.filter(([key]) => norm(key.split("/").at(-1) ?? "") === norm(table.columns[column]!));
      if (spec.selector?.startsWith("/")) {
        let entries = documents;
        for (const segment of spec.selector.slice(1).split("/")) {
          const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
          entries = entries.flatMap((entry): unknown[] => {
            if (key === "*" && Array.isArray(entry)) return entry;
            if (entry && typeof entry === "object" && Object.hasOwn(entry, key)) return [(entry as Record<string, unknown>)[key]];
            return [];
          });
        }
        selected = entries.length ? [[spec.selector, entries]] : [];
      }
      let textSource: TextSource | undefined;
      if (spec.selector?.startsWith("text:")) {
        const prefix = spec.selector.slice(5);
        const matches: Array<{ path: string; line: number; text: string }> = [];
        // Match original allowed sources, not extracted Markdown, code, or a workspace-wide number search.
        for (const source of new Set(row.source_paths)) {
          if (!source.startsWith("source/") || !/\.(txt|log)$/i.test(source)) continue;
          if (!logLines.has(source)) {
            const file = sourceFiles.get(source)!;
            if (statSync(file).size > 32 * 1024 * 1024) fail(`original log ${source} exceeds the 32 MiB extraction limit`);
            const body = readFileSync(file, "utf8");
            if (body.includes("\0") || body.includes("\uFFFD")) fail(`original log ${source} is not valid plain UTF-8 text`);
            logLines.set(source, body.split(/\r\n|\n|\r/));
          }
          logLines.get(source)!.forEach((line, index) => {
            if (line.startsWith(prefix)) matches.push({ path: source, line: index + 1, text: line });
          });
        }
        if (matches.length !== 1) fail(`text: prefix must match exactly one original source .txt/.log line across row.source_paths; found ${matches.length}. Prefixes are literal and whitespace-sensitive, not regexes`);
        const match = matches[0]!;
        const payload = match.text.slice(prefix.length);
        if (/\b(?:NaN|Infinity|Inf)\b/i.test(payload)) fail("selected log line contains non-finite measurements");
        const recorded = payload.match(LOG_NUMBER) ?? [];
        if (spec.index === undefined && recorded.length !== 1) fail(`selected log line has ${recorded.length} numeric tokens after the prefix; specify an explicit zero-based index`);
        const index = spec.index ?? 0;
        const token = recorded[index];
        if (token === undefined || numeric(token) === null) fail(`log token index ${index} is absent or non-finite; the matching line has ${recorded.length} numeric tokens after the prefix`);
        textSource = { path: match.path, line: match.line, prefix, index, token: token! };
        selected = [[spec.selector, [numeric(token)]]];
      }
      if (!spec.selector && !selected.length && numericGroups.length === 1) selected = numericGroups;
      if (selected.length !== 1) fail("numeric source field is missing or ambiguous (use a JSON pointer, CSV header, or exact text: prefix on an original .txt/.log source)");
      const numbers = selected[0]![1].map(numeric);
      if (!numbers.length || numbers.some((entry) => entry === null)) fail("selected field includes missing or nonnumeric measurements");
      const values = numbers as number[];
      if (spec.operation === "direct" && new Set(values).size > 1) fail("direct cell matches multiple source records; use a row label present in the records or an indexed JSON selector");
      const mean = values.reduce((total, entry) => total + entry / values.length, 0);
      let expected: number[];
      const std = () => {
        if (spec.ddof === undefined || values.length <= spec.ddof) return fail("std requires an explicit population/sample convention and enough measurements");
        return Math.sqrt(values.reduce((total, entry) => total + (entry - mean) ** 2, 0) / (values.length - spec.ddof));
      };
      switch (spec.operation) {
        case "direct": expected = values; break;
        case "min": expected = [values.reduce((a, b) => Math.min(a, b))]; break;
        case "max": expected = [values.reduce((a, b) => Math.max(a, b))]; break;
        case "mean": expected = [mean]; break;
        case "std": expected = [std()]; break;
        case "range": expected = [values.reduce((a, b) => Math.min(a, b)), values.reduce((a, b) => Math.max(a, b))]; break;
        case "mean_std": expected = [mean, std()]; break;
      }
      const matches = (token: string, actual: number) => {
        if (spec.decimals !== undefined) return Number.isFinite(actual) &&
          Math.abs(Number(token) - Number(actual.toFixed(spec.decimals))) <= Number.EPSILON * Math.abs(actual) * 8;
        const [mantissa = "", exponent = "0"] = token.toLowerCase().split("e");
        const decimals = (mantissa.split(".")[1]?.length ?? 0) - Number(exponent);
        return Number.isFinite(actual) && Math.abs(Number(token) - actual) <=
          0.5 * 10 ** -decimals + Number.EPSILON * Math.abs(actual) * 8;
      };
      const valid = spec.operation === "direct" ? tokens.length === 1 && expected.some((entry) => matches(tokens[0]!, entry)) :
        tokens.length === expected.length && tokens.every((token, index) => matches(token, expected[index]!));
      if (!valid) fail(`reported ${JSON.stringify(value)} does not match ${spec.operation} of the selected source measurements`);
      checks.push({ row: rowIndex, column, operation: spec.operation, selectors: selected.map(([key]) => key),
        ...(textSource ? { text_source: textSource } : {}),
        expected: spec.operation === "direct" ? expected.filter((entry) => matches(tokens[0]!, entry)).slice(0, 1) : expected });
    }
  }
  return checks;
}

function safeFile(root: string, rel: string): string {
  if (isAbsolute(rel) || rel.includes("\\") || rel.split("/").includes("..")) throw new Error(`Unsafe path: ${rel}`);
  const abs = assertInside(root, rel);
  const base = realpathSync(root);
  const real = realpathSync(abs);
  if (base !== resolve(root) || !real.startsWith(base + sep) || !lstatSync(abs).isFile()) throw new Error(`Not a regular file inside ${root}: ${rel}`);
  return abs;
}

function tableArtifacts(workspace: string) {
  const plan = OutlineSchema.parse(readJson(join(workspace, ARTIFACTS.outlineV1))).table_plan;
  const presentationPath = join(workspace, ".brain/manuscript/table_presentation.json");
  const presentations = z.record(z.object({ caption: z.string().optional(), columns: z.array(z.string()).optional(),
    row_labels: z.array(z.string()).optional(), row_header: z.string().optional() }).strict())
    .parse(existsSync(presentationPath) ? readJson(presentationPath) : {});
  for (const id of Object.keys(presentations)) {
    if (!plan.some((table) => table.table_id === id)) throw new Error(`Unknown table presentation ID: ${id}`);
  }
  if (new Set(plan.map((table) => table.table_id.toLowerCase())).size !== plan.length) throw new Error("Duplicate table_id");
  return plan.map((table) => {
    const sourceFiles = new Map<string, string>();
    const sources = [...new Set([...table.source_paths, ...table.rows.flatMap((row) => row.source_paths)])].sort();
    const source_hashes = Object.fromEntries(sources.map((rel) => {
      const rootRel = rel.startsWith("source/") ? "source" : rel.startsWith(".brain/input/") ? ".brain/input" : null;
      if (!rootRel) throw new Error(`Table ${table.table_id}: source must be inside source/ or .brain/input/: ${rel}`);
      const path = safeFile(join(workspace, rootRel), rel.slice(rootRel.length + 1));
      sourceFiles.set(rel, path);
      return [rel, digestFile(path)];
    }));
    const numeric_verification = verifyTableNumbers(table, sourceFiles);
    const presentation = presentations[table.table_id] ?? {};
    if ((presentation.columns && presentation.columns.length !== table.columns.length) ||
        (presentation.row_labels && presentation.row_labels.length !== table.rows.length)) {
      throw new Error(`Table ${table.table_id}: presentation must preserve row and column counts`);
    }
    const tex = tableTex({ ...table, caption: presentation.caption ?? table.caption,
      columns: presentation.columns ?? table.columns,
      rows: table.rows.map((row, index) => ({ ...row, label: presentation.row_labels?.[index] ?? row.label })) },
    presentation.row_header);
    return { table, tex, manifest: { version: 1, table_id: table.table_id,
      plan_sha256: digestValue(table), presentation, source_hashes, numeric_verification,
      tex_sha256: createHash("sha256").update(tex).digest("hex") } };
  });
}

function escapeTex(value: string | number | null): string {
  if (value === null) return "--";
  const escaped: Record<string, string> = { "\\": "\\textbackslash{}", "{": "\\{", "}": "\\}",
    "$": "\\$", "&": "\\&", "#": "\\#", "%": "\\%", "_": "\\_", "~": "\\textasciitilde{}", "^": "\\textasciicircum{}" };
  return String(value).replace(/[\\{}$&#%_~^]/g, (char) => escaped[char]!).replace(/[\r\n\t]+/g, " ");
}

function tableTex(table: TableSpec, rowHeader = "Item"): string {
  const width = 1 / (table.columns.length + 1);
  const layout = `p{\\dimexpr${width.toFixed(5)}\\linewidth-2\\tabcolsep\\relax}`.repeat(table.columns.length + 1);
  const displayText = (value: string): string => value.split(/((?:alpha|beta|gamma|delta|theta|lambda|sigma|mu|nu|phi|psi|omega)_[A-Za-z0-9]+|\b[A-Za-z]\^[+-]?\d+\b)/g)
    .map((part) => {
      const greek = /^(alpha|beta|gamma|delta|theta|lambda|sigma|mu|nu|phi|psi|omega)_([A-Za-z0-9]+)$/.exec(part);
      if (greek) return `\\ensuremath{\\${greek[1]}_{${greek[2]}}}`;
      const power = /^([A-Za-z])\^([+-]?\d+)$/.exec(part);
      return power ? `\\ensuremath{${power[1]}^{${power[2]}}}` : escapeTex(part.replaceAll("_", " "));
    }).join("");
  const displayValue = (value: string | number | null, decimals?: number): string => {
    if (typeof value !== "number") return value === null ? "--" : displayText(value);
    const fixed = decimals === undefined ? String(value) : value.toFixed(decimals);
    const text = value !== 0 && Math.abs(value) < 1e-4 && (decimals === undefined || decimals > 4)
      ? Number(fixed).toExponential() : fixed;
    const scientific = /^(.+)[eE]([+-]?\d+)$/.exec(text);
    return scientific ? `\\ensuremath{${scientific[1]}\\times10^{${Number(scientific[2])}}}` : text;
  };
  return ["% Generated by PaperOrchestra from the locked table plan; null values are unavailable.",
    "\\begin{table}[htbp]", "\\centering", "\\small", `\\caption{${displayText(table.caption)}}`,
    `\\label{tab:${table.table_id}}`, `\\begin{tabular}{${layout}}`, "\\hline",
    [rowHeader, ...table.columns].map(displayText).join(" & ") + " " + "\\".repeat(2), "\\hline",
    ...table.rows.map((row) => [displayText(row.label), ...row.values.map((value, index) =>
      displayValue(value, (row.cell_verification?.[index] ?? table.column_verification?.[index])?.decimals))]
      .join(" & ") + " " + "\\".repeat(2)),
    "\\hline", "\\end{tabular}", "\\end{table}", ""].join("\n");
}

export function tablePlanCheck(workspace: string): Check {
  try {
    const tables = tableArtifacts(workspace);
    return { name: "table_plan", passed: true, advisory: false,
      detail: `${tables.length} table plans checked against source measurements` };
  } catch (error) {
    const detail = error instanceof ZodError ? error.issues.map((issue) =>
      `${issue.path.join(".") || "table_plan"}: ${issue.message}`).join("; ") : String(error);
    return { name: "table_plan", passed: false, advisory: false,
      detail: `${detail}. Correct table_plan in outline_v1.json using actual source columns and supported operations. ${detail.includes("row.cell_verification") ? "" : TABLE_VERIFICATION_HELP}`.trim() };
  }
}

export function publishTables(workspace: string): number {
  const artifacts = tableArtifacts(workspace); // Validate the entire plan before writing anything.
  const dir = join(workspace, TABLES);
  ensureDir(dir);
  if (realpathSync(dir) !== resolve(dir)) throw new Error("Refusing symlinked table output directory");
  for (const { table, tex, manifest } of artifacts) {
    const target = join(dir, `${table.table_id}.tex`);
    const temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, tex, { flag: "wx" });
    renameSync(temporary, target);
    writeJsonAtomic(join(dir, `${table.table_id}.json`), manifest);
  }
  return artifacts.length;
}

/** Follow ordinary input/include commands, rather than counting commented or unused files. */
export function tableCoverage(workspace: string, sourceRel: string): Check {
  const name = "table_coverage";
  try {
    const artifacts = tableArtifacts(workspace);
    const root = paths(workspace).brainManuscript;
    const included = new Set<string>();
    const visit = (file: string) => {
      const rel = relative(root, file);
      safeFile(root, rel);
      if (included.has(rel)) return;
      included.add(rel);
      const text = readFileSync(file, "utf8").replace(/(?<!\\)%[^\n]*/g, "");
      for (const match of text.matchAll(/\\(?:input|include)\s*\{([^{}]+)\}/g)) {
        const ref = match[1]!;
        const candidate = ref.endsWith(".tex") ? ref : `${ref}.tex`;
        visit(safeFile(root, candidate));
      }
    };
    visit(assertInside(workspace, sourceRel));
    for (const { table, tex, manifest } of artifacts) {
      const rel = `tables/${table.table_id}.tex`;
      const actual = readFileSync(safeFile(root, rel), "utf8");
      if (!included.has(rel) || actual !== tex || !actual.includes(`\\label{tab:${table.table_id}}`) ||
          digestValue(readJson(join(workspace, TABLES, `${table.table_id}.json`))) !== digestValue(manifest)) {
        throw new Error(`Include the unmodified generated ${rel} with label tab:${table.table_id}; regenerate stale manifests`);
      }
    }
    return { name, passed: true, advisory: false, detail: `${artifacts.length} planned tables included with matching provenance` };
  } catch (error) {
    return { name, passed: false, advisory: false, detail: String(error) };
  }
}

/** Export only manuscript/build dependencies, never the imported research-paper tree. */
export function exportSubmission(workspace: string): void {
  const p = paths(workspace);
  const output = join(workspace, "submission");
  if (existsSync(output) && (lstatSync(output).isSymbolicLink() || realpathSync(output) !== resolve(output))) throw new Error("Refusing symlinked submission directory");
  const files = new Map<string, string>();
  const collect = (root: string, template = false) => {
    for (const rel of walkFiles(root)) {
      if (!isLatexDependency(rel) || (template && rel === "template.tex")) continue;
      files.set(rel, safeFile(root, rel));
    }
  };
  collect(p.template, true);
  collect(p.brainManuscript);
  if (existsSync(join(workspace, ARTIFACTS.references))) files.set("references.bib", safeFile(p.brainRaw, "references.bib"));
  files.set("main.tex", safeFile(p.brainManuscript, "final_paper.tex"));
  files.set("final.pdf", safeFile(p.brainManuscript, "final_paper.pdf"));
  // Build staging resolves paths from manuscript root; preserve that layout. Rewrite only the
  // common generated-bibliography path, which otherwise escapes the portable export.
  const rewritten = new Map<string, string>();
  for (const [rel, from] of files) {
    if (extname(rel) !== ".tex") continue;
    const text = readFileSync(from, "utf8").replace(/(\\(?:bibliography|addbibresource)(?:\[[^\]]*\])?\s*\{)([^{}]+)(\})/g,
      (_all, before: string, refs: string, after: string) => before + refs.split(",").map((ref) => {
        const value = ref.trim();
        return ["../raw/references", "../raw/references.bib", ".brain/raw/references", ARTIFACTS.references].includes(value)
          ? `references${value.endsWith(".bib") ? ".bib" : ""}` : value;
      }).join(",") + after);
    for (const match of text.replace(/(?<!\\)%[^\n]*/g, "").matchAll(/\\(?:input|include|includegraphics|bibliography|addbibresource|bibliographystyle)\*?(?:\[[^\]]*\])?\s*\{([^{}]+)\}/g)) {
      for (const ref of match[1]!.split(",")) {
        if (isAbsolute(ref.trim()) || ref.includes("\\") || ref.split("/").includes("..") || /(?:^|\/)source\//.test(ref)) {
          throw new Error(`Nonportable or unsafe submission dependency in ${rel}: ${ref}`);
        }
      }
    }
    rewritten.set(rel, text);
  }
  const contents = new Map<string, Buffer>();
  for (const [rel, from] of files) {
    contents.set(rel, rewritten.has(rel) ? Buffer.from(rewritten.get(rel)!) : readFileSync(from));
  }
  contents.set("README.md", Buffer.from("# Submission build\n\nRun from this directory with a TeX distribution and the venue's required packages:\n\n```sh\npdflatex -no-shell-escape -interaction=nonstopmode main.tex\nbibtex main\npdflatex -no-shell-escape -interaction=nonstopmode main.tex\npdflatex -no-shell-escape -interaction=nonstopmode main.tex\n```\n\nFor biblatex, use `biber main` instead of `bibtex main`. The supplied `final.pdf` is the controller-built manuscript; rebuilding produces `main.pdf`.\n"));
  const manifest = { version: 1, files: Object.fromEntries([...contents].sort(([a], [b]) => a.localeCompare(b))
    .map(([rel, content]) => [rel, createHash("sha256").update(content).digest("hex")])) };
  const manifestPath = join(p.runDir, "submission.json");
  const existing = walkFiles(output);
  if (existing.length) {
    const previous = existsSync(manifestPath) ? readJson(manifestPath) : null;
    if (digestValue(previous) !== digestValue(manifest) || existing.length !== contents.size ||
        existing.some((rel) => !contents.has(rel) || digestFile(safeFile(output, rel)) !== manifest.files[rel])) {
      throw new Error("submission/ contains changed, stale or user-owned files; refusing to overwrite. An unchanged controller-owned export can be resumed");
    }
    return;
  }
  ensureDir(output);
  for (const [rel, content] of contents) {
    const to = assertInside(output, rel);
    ensureDir(dirname(to));
    writeFileSync(to, content, { flag: "wx" });
  }
  writeJsonAtomic(manifestPath, manifest);
}
