import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
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
  assertNoSymlinks(abs);
  const base = realpathSync(root);
  const real = realpathSync(abs);
  if (base !== resolve(root) || !real.startsWith(base + sep) || !lstatSync(abs).isFile()) throw new Error(`Not a regular file inside ${root}: ${rel}`);
  return abs;
}

function assertNoSymlinks(path: string): void {
  const abs = resolve(path);
  if (dirname(abs) !== abs) assertNoSymlinks(dirname(abs));
  const stat = lstatSync(abs, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) throw new Error(`Refusing symlink: ${abs}`);
}

// Keep offsets intact for surgical source replacement, including after an escaped backslash.
function uncommentTex(source: string): string {
  return source.replace(/(\\*)%[^\r\n]*/g, (match, slashes: string) =>
    slashes.length % 2 ? match : slashes + " ".repeat(match.length - slashes.length));
}

function tableArtifacts(workspace: string) {
  const plan = OutlineSchema.parse(readJson(join(workspace, ARTIFACTS.outlineV1))).table_plan;
  const presentationPath = join(workspace, ".brain/manuscript/table_presentation.json");
  const presentations = z.record(z.object({ caption: z.string().optional(), columns: z.array(z.string()).optional(),
    row_labels: z.array(z.string()).optional(), row_header: z.string().optional(),
    decimals: z.union([z.number().int().min(0).max(100), z.array(z.number().int().min(0).max(100).nullable())]).optional() }).strict())
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
        (presentation.row_labels && presentation.row_labels.length !== table.rows.length) ||
        (Array.isArray(presentation.decimals) && presentation.decimals.length !== table.columns.length)) {
      throw new Error(`Table ${table.table_id}: presentation must preserve row and column counts`);
    }
    const tex = tableTex({ ...table, caption: presentation.caption ?? table.caption,
      columns: presentation.columns ?? table.columns,
      rows: table.rows.map((row, index) => ({ ...row, label: presentation.row_labels?.[index] ?? row.label })) },
    presentation.row_header, presentation.decimals);
    return { table, tex, manifest: { version: 1, table_id: table.table_id,
      plan_sha256: digestValue(table), presentation, presentation_sha256: digestValue(presentation),
      source_hashes, numeric_verification,
      numeric_cells_verified: numeric_verification.length,
      numeric_tokens_verified: numeric_verification.reduce((total, cell) => total + cell.expected.length, 0),
      rows: table.rows.length, columns: table.columns.length,
      tex_sha256: createHash("sha256").update(tex).digest("hex") } };
  });
}

function escapeTex(value: string | number | null): string {
  if (value === null) return "--";
  const escaped: Record<string, string> = { "\\": "\\textbackslash{}", "{": "\\{", "}": "\\}",
    "$": "\\$", "&": "\\&", "#": "\\#", "%": "\\%", "_": "\\_", "~": "\\textasciitilde{}", "^": "\\textasciicircum{}" };
  return String(value).replace(/[\\{}$&#%_~^]/g, (char) => escaped[char]!).replace(/[\r\n\t]+/g, " ");
}

function tableTex(table: TableSpec, rowHeader = "Item", decimals?: number | (number | null)[]): string {
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
    if (typeof value !== "number") {
      if (value === null) return "--";
      if (decimals === undefined) return displayText(value);
      // Only the same numeric/range grammar accepted by provenance verification is formatted.
      const shape = value.replace(NUMBER, "#").replace(/[()%]/g, "").trim();
      if (!/^(?:#|#\s*(?:to|[-\u2013\u2014]|\+\/-|\u00b1)\s*#)$/.test(shape)) return displayText(value);
      return value.split(new RegExp(`(${NUMBER.source})`, "g")).map((part) =>
        numeric(part) === null ? displayText(part).replace(/\u2013|\u2014/g, "--").replace(/\u00b1/g, "\\ensuremath{\\pm}") :
          displayValue(Number(part), decimals)).join("");
    }
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
      displayValue(value, decimals === undefined ? (row.cell_verification?.[index] ?? table.column_verification?.[index])?.decimals :
        Array.isArray(decimals) ? decimals[index] ?? undefined : decimals))]
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

/** Current mechanically verified metadata, for caption writing and independent review. */
export function tablePresentationMetadata(workspace: string) {
  return tableArtifacts(workspace).map(({ manifest }) => manifest);
}

/** Bind identities to controller-verified data, never to numbers supplied in the draft. */
export function bindPlannedTables(workspace: string, source: string): string {
  const artifacts = tableArtifacts(workspace);
  const labels = new Map(artifacts.map(({ table }) => [`tab:${table.table_id}`, table.table_id]));
  const text = uncommentTex(source);
  const seen = new Set<string>();
  const claim = (id: string) => {
    if (seen.has(id)) throw new Error(`Duplicate planned table binding: ${id}`);
    seen.add(id);
  };
  for (const match of text.matchAll(/(?<!\\)\\(?:input|include)\s*\{(?:\.\/)?tables\/([^{}/]+?)(?:\.tex)?\}/g)) {
    if (artifacts.some(({ table }) => table.table_id === match[1])) claim(match[1]!);
  }
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  let float: { start: number; environment: string } | undefined;
  for (const match of text.matchAll(/(?<!\\)\\(begin|end)\s*\{(table\*?)\}/g)) {
    if (match[1] === "begin") {
      if (float) throw new Error("Nested table floats cannot be bound safely");
      float = { start: match.index!, environment: match[2]! };
      continue;
    }
    if (!float || float.environment !== match[2]) throw new Error("Unbalanced table float");
    const end = match.index! + match[0].length;
    const canonical = [...text.slice(float.start, end).matchAll(/(?<!\\)\\label\s*\{([^{}]+)\}/g)]
      .map((label) => labels.get(label[1]!.trim())).filter((id): id is string => id !== undefined);
    if (canonical.length > 1) throw new Error("Table float carries multiple canonical planned labels");
    if (canonical.length === 1) {
      const id = canonical[0]!;
      claim(id);
      edits.push({ start: float.start, end, replacement: `\\input{tables/${id}.tex}` });
    }
    float = undefined;
  }
  if (float) throw new Error("Unclosed table float");
  for (const [label] of labels) {
    const occurrences = [...text.matchAll(/(?<!\\)\\label\s*\{([^{}]+)\}/g)].filter((match) => match[1]!.trim() === label);
    if (occurrences.length > 1) throw new Error(`Duplicate canonical planned label: ${label}`);
    if (occurrences.some((match) => !edits.some((edit) => match.index! >= edit.start && match.index! < edit.end))) {
      throw new Error(`Canonical planned label must be inside a table float: ${label}`);
    }
  }
  for (const edit of edits.reverse()) source = source.slice(0, edit.start) + edit.replacement + source.slice(edit.end);
  return source;
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
      const text = uncommentTex(readFileSync(file, "utf8"));
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

const SubmissionManifest = z.object({ version: z.literal(1), files: z.record(z.string().regex(/^[a-f0-9]{64}$/)) }).strict();
const SubmissionStatus = z.object({ version: z.literal(1), status: z.enum(["review_pending", "completed"]),
  content_sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

function writeSubmissionRecord(path: string, value: unknown): void {
  assertNoSymlinks(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  renameSync(temporary, path);
}

function contentManifest(contents: Map<string, Buffer>) {
  return { version: 1 as const, files: Object.fromEntries([...contents].sort(([a], [b]) => a.localeCompare(b))
    .map(([rel, content]) => [rel, createHash("sha256").update(content).digest("hex")])) };
}

/**
 * LaTeX's filecontents environment is a real build dependency, not merely a
 * comment.  Agents sometimes use it for a venue-specific bibliography (for
 * example, an identifier-rendering .bib beside the controller bibliography).
 * Preserve that generated file in the portable submission package so the
 * package validator and an independent rebuild see the same dependency.
 */
function addEmbeddedFilecontents(contents: Map<string, Buffer>): void {
  const block = /\\begin\{filecontents\*?\}\s*\{([^{}]+)\}([\s\S]*?)\\end\{filecontents\*?\}/g;
  for (const [owner, bytes] of [...contents]) {
    if (!/\.tex$/i.test(owner)) continue;
    const text = bytes.toString("utf8");
    for (const match of text.matchAll(block)) {
      const rel = match[1]!.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(rel) || /\.(?:tex|sty|cls)$/i.test(rel)) {
        throw new Error(`Unsafe embedded filecontents dependency in ${owner}: ${rel}`);
      }
      const content = Buffer.from(match[2]!.replace(/^\r?\n/, ""));
      const existing = contents.get(rel);
      // references.bib is controller-owned and is deliberately copied from
      // .brain/raw.  An agent may embed a convenience copy in filecontents;
      // the portable package must keep the controller copy authoritative.
      if (rel === "references.bib" && existing) continue;
      if (existing && !existing.equals(content)) {
        throw new Error(`Embedded filecontents conflicts with packaged file: ${rel}`);
      }
      if (!existing) contents.set(rel, content);
    }
  }
}

function submissionContents(root: string): Map<string, Buffer> {
  assertNoSymlinks(root);
  if (!lstatSync(root).isDirectory()) throw new Error("Submission must be a directory");
  const contents = new Map(walkFiles(root).map((rel) => [rel, readFileSync(safeFile(root, rel))]));
  // Empty, user-created directories are extras too, not permission to overwrite them.
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = join(dir, entry.name);
      if (![...contents.keys()].some((rel) => rel.startsWith(relative(root, child) + "/"))) {
        throw new Error(`Unexpected empty submission directory: ${relative(root, child)}`);
      }
      visit(child);
    }
  };
  visit(root);
  return contents;
}

/** Static portable LaTeX dependencies only; macro-computed file paths are not guessed. */
function packageDetails(contents: Map<string, Buffer>, validate = true) {
  for (const rel of ["main.tex", "references.bib", "final.pdf", "final_paper.pdf", "README.md"]) {
    if (!contents.get(rel)?.length) throw new Error(`Missing or empty submission file: ${rel}`);
  }
  if (!contents.get("final.pdf")!.equals(contents.get("final_paper.pdf")!) ||
      !contents.get("final.pdf")!.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("Invalid or inconsistent submission PDF aliases");
  const cited = new Set<string>();
  const bibKeys = new Set([...contents.get("references.bib")!.toString("utf8")
    .replace(/^\s*%.*$/gm, "").matchAll(/@(?!(?:comment|string|preamble)\b)[A-Za-z]+\s*[{(]\s*([^\s,{}()]+)\s*,/gi)].map((match) => match[1]!));
  const visited = new Set<string>();
  const graphics = [""];
  let bibliography: "inline" | "bibtex" | "biber" = "inline";
  const portable = (ref: string) => {
    if (!ref || isAbsolute(ref) || /[\\#{}\x00-\x1f]/.test(ref) || ref.split("/").includes("..") ||
        /(?:^|\/)(?:source|\.brain|\.po-run)(?:\/|$)/.test(ref) || /^[A-Za-z]:/.test(ref)) {
      throw new Error(`Nonportable or unsafe submission dependency: ${ref}`);
    }
    return ref.replace(/^(?:\.\/)+/, "");
  };
  const visit = (rel: string) => {
    if (visited.has(rel)) return;
    visited.add(rel);
    const text = uncommentTex(contents.get(rel)!.toString("utf8"));
    for (const match of text.matchAll(/(?<!\\)\\graphicspath\s*\{((?:\s*\{[^{}]*\}\s*)+)\}/g)) {
      for (const path of match[1]!.matchAll(/\{([^{}]*)\}/g)) graphics.push(portable(path[1]!));
    }
    for (const match of text.matchAll(/(?<!\\)\\(?:[Cc]ite[A-Za-z]*|[Pp]arencite|[Tt]extcite|[Aa]utocite|[Ff]ootcite|nocite)\*?\s*(?:\[[^\]]*\]\s*)*\{([^{}]+)\}/g)) {
      match[1]!.split(",").map((key) => key.trim()).filter(Boolean).forEach((key) => cited.add(key));
    }
    for (const match of text.matchAll(/(?<!\\)\\(input|include|includegraphics|bibliography|addbibresource|bibliographystyle|usepackage|RequirePackage|documentclass|LoadClass)\b\*?\s*(?:\[[^\]]*\]\s*)?/g)) {
      const command = match[1]!;
      const rest = text.slice(match.index! + match[0].length);
      const argument = /^\{([^{}]+)\}/.exec(rest)?.[1] ?? (command === "input" ? /^([^\s\\{}]+)/.exec(rest)?.[1] : undefined);
      if (argument === undefined) {
        if (/\.(sty|cls)$/.test(rel)) continue;
        throw new Error(`Unsupported or dynamic submission dependency in ${rel}: ${command}`);
      }
      if (command === "bibliography" && bibliography !== "biber") bibliography = "bibtex";
      if (command === "addbibresource") bibliography = "biber";
      for (const raw of argument.split(",")) {
        // Local style implementations can have parameterized internals; main/inputs cannot.
        if (/\.(sty|cls)$/.test(rel) && /[\\#]/.test(raw)) continue;
        const ref = portable(raw.trim());
        const extensions = command === "includegraphics" ? ["", ".pdf", ".png", ".jpg", ".jpeg", ".eps"] :
          command === "bibliography" || command === "addbibresource" ? ["", ".bib"] :
            command === "bibliographystyle" ? ["", ".bst"] :
              command === "usepackage" || command === "RequirePackage" ? ["", ".sty"] :
                command === "documentclass" || command === "LoadClass" ? ["", ".cls"] : ["", ".tex"];
        const candidates = (command === "includegraphics" ? graphics : [""])
          .flatMap((prefix) => extensions.map((extension) => `${prefix}${ref}${extension}`));
        const found = candidates.find((candidate) => contents.has(candidate));
        if (!found) {
          if (["bibliographystyle", "usepackage", "RequirePackage", "documentclass", "LoadClass"].includes(command) &&
              /^[A-Za-z0-9_.-]+$/.test(ref)) continue; // Installed TeX-distribution dependency.
          throw new Error(`Missing submission dependency in ${rel}: ${ref}`);
        }
        if (/\.(tex|sty|cls)$/.test(found)) visit(found);
      }
    }
  };
  visit("main.tex");
  for (const key of cited) {
    if (validate && key !== "*" && !bibKeys.has(key)) throw new Error(`Controller references.bib is missing cited key: ${key}`);
  }
  return { cited_keys: [...cited].sort(), available_bibkeys: [...bibKeys].sort(), bibliography };
}

/** Validate the package on disk, not a promise to export after independent review. */
export function submissionArtifacts(workspace: string, requireComplete = false): Check {
  try {
    const p = paths(workspace);
    const contents = submissionContents(join(workspace, "submission"));
    const manifest = SubmissionManifest.parse(readJson(safeFile(p.runDir, "submission.json")));
    if (digestValue(manifest) !== digestValue(contentManifest(contents))) throw new Error("Submission ownership/file hashes differ from submission.json");
    const status = SubmissionStatus.parse(JSON.parse(contents.get("submission-status.json")?.toString("utf8") ?? "null"));
    if (requireComplete && status.status !== "completed") throw new Error("Submission is review_pending, not completed");
    contents.delete("submission-status.json");
    const snapshot = SubmissionManifest.parse(readJson(safeFile(p.runDir, "submission-content.json")));
    if (digestValue(snapshot) !== digestValue(contentManifest(contents)) || status.content_sha256 !== digestValue(snapshot)) {
      throw new Error("Submission content snapshot/hash mismatch");
    }
    if (!contents.get("references.bib")!.equals(readFileSync(safeFile(p.brainRaw, "references.bib")))) {
      throw new Error("Submission bibliography differs from controller references.bib");
    }
    const details = packageDetails(contents);
    return { name: "submission_artifacts", passed: true, advisory: false,
      detail: `${status.status}: ${contents.size} content files verified; ${details.cited_keys.length} cited keys; content ${status.content_sha256}` };
  } catch (error) {
    return { name: "submission_artifacts", passed: false, advisory: false, detail: String(error) };
  }
}

export function submissionEvidence(workspace: string) {
  const validation = submissionArtifacts(workspace);
  const result: { directory: string; status: string | null; files: Record<string, string>; cited_keys: string[];
    available_bibkeys: string[]; validation: Check } = {
    directory: "submission", status: null, files: {}, cited_keys: [], available_bibkeys: [], validation,
  };
  try {
    const contents = submissionContents(join(workspace, "submission"));
    result.files = contentManifest(contents).files;
    const status = SubmissionStatus.safeParse(JSON.parse(contents.get("submission-status.json")?.toString("utf8") ?? "null"));
    result.status = status.success ? status.data.status : null;
    const details = packageDetails(contents, false);
    result.cited_keys = details.cited_keys;
    result.available_bibkeys = details.available_bibkeys;
  } catch { /* Validation already contains the failure; never follow unsafe paths for evidence. */ }
  return result;
}

/** ready is a primary-controller assertion AFTER independent review, never inferred here. */
export function exportSubmission(workspace: string, options: { sourceRel?: string; ready?: boolean } = {}): void {
  const p = paths(workspace);
  const output = join(workspace, "submission");
  assertNoSymlinks(output);
  assertNoSymlinks(p.runDir);
  ensureDir(p.runDir);
  const manifestPath = join(p.runDir, "submission.json");
  const contentPath = join(p.runDir, "submission-content.json");
  assertNoSymlinks(manifestPath);
  assertNoSymlinks(contentPath);
  let previous: ReturnType<typeof contentManifest> | undefined;
  if (existsSync(output)) {
    previous = SubmissionManifest.parse(readJson(safeFile(p.runDir, "submission.json")));
    const existing = submissionContents(output);
    if (digestValue(previous) !== digestValue(contentManifest(existing))) {
      throw new Error("submission/ contains user-modified or extra files; refusing to overwrite");
    }
    if (existing.has("submission-status.json")) {
      const status = SubmissionStatus.parse(JSON.parse(existing.get("submission-status.json")!.toString("utf8")));
      existing.delete("submission-status.json");
      const snapshot = SubmissionManifest.parse(readJson(safeFile(p.runDir, "submission-content.json")));
      if (digestValue(snapshot) !== digestValue(contentManifest(existing)) || status.content_sha256 !== digestValue(snapshot)) {
        throw new Error("Previous submission content snapshot/hash is inconsistent; refusing to replace it");
      }
    }
  } else if (existsSync(manifestPath)) throw new Error("Controller submission directory is missing; refusing to discard its ownership record");
  const files = new Map<string, string>();
  const collect = (root: string, template = false) => {
    assertNoSymlinks(root);
    for (const rel of walkFiles(root)) {
      if (!isLatexDependency(rel) || (template && rel === "template.tex")) continue;
      if (["main.tex", "raw_draft.tex", "final_paper.tex", "raw_draft.pdf", "final.pdf", "final_paper.pdf"].includes(rel)) continue;
      files.set(rel, safeFile(root, rel));
    }
  };
  collect(p.template, true);
  collect(p.brainManuscript);
  // A manuscript may identify source-level checkers as evidence-bearing
  // provenance.  Keep the small, digest-locked source/code bundle in the
  // standalone package under a portable path; otherwise the paper can be
  // readable yet its claimed audit trail disappears at export time.
  const evidenceCode = join(p.source, "code");
  if (existsSync(evidenceCode)) {
    assertNoSymlinks(evidenceCode);
    for (const rel of walkFiles(evidenceCode)) {
      const target = join("code", rel);
      if (files.has(target)) throw new Error(`Evidence source collides with submission file: ${target}`);
      files.set(target, safeFile(evidenceCode, rel));
    }
  }
  files.set("references.bib", safeFile(p.brainRaw, "references.bib"));
  const sourceRel = options.sourceRel ?? ARTIFACTS.finalTex;
  if (sourceRel !== ARTIFACTS.finalTex && sourceRel !== ARTIFACTS.rawDraft) throw new Error("Submission sourceRel must be finalTex or rawDraft");
  files.set("main.tex", safeFile(workspace, sourceRel));
  files.set("final.pdf", safeFile(p.brainManuscript, "final_paper.pdf"));
  files.set("final_paper.pdf", safeFile(p.brainManuscript, "final_paper.pdf"));
  // Build staging resolves paths from manuscript root; preserve that layout. Rewrite only the
  // common generated-bibliography path, which otherwise escapes the portable export.
  const rewritten = new Map<string, string>();
  for (const [rel, from] of files) {
    if (extname(rel) !== ".tex") continue;
    const text = readFileSync(from, "utf8")
      .replace(/\.brain\/input\/code\//g, "code/")
      .replace(/(\\(?:bibliography|addbibresource)(?:\[[^\]]*\])?\s*\{)([^{}]+)(\})/g,
      (_all, before: string, refs: string, after: string) => before + refs.split(",").map((ref) => {
        const value = ref.trim();
        return ["../raw/references", "../raw/references.bib", ".brain/raw/references", ARTIFACTS.references].includes(value)
          ? `references${value.endsWith(".bib") ? ".bib" : ""}` : value;
      }).join(",") + after);
    for (const match of uncommentTex(text).matchAll(/\\(?:input|include|includegraphics|bibliography|addbibresource|bibliographystyle)\*?(?:\[[^\]]*\])?\s*\{([^{}]+)\}/g)) {
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
  contents.set("README.md", Buffer.from("Build instructions pending validation\n"));
  addEmbeddedFilecontents(contents);
  const { bibliography } = packageDetails(contents);
  const latex = "pdflatex -no-shell-escape -interaction=nonstopmode -halt-on-error main.tex";
  contents.set("README.md", Buffer.from(`# Submission build\n\nRun from this directory with a TeX distribution and the venue's required packages:\n\n\`\`\`sh\n${latex}\n${bibliography === "inline" ? "" : `${bibliography === "biber" ? "biber" : "bibtex"} main\n`}${latex}\n${latex}\n\`\`\`\n\n${bibliography === "inline" ? "The bibliography is inline; do not run BibTeX or Biber. " : ""}references.bib is the complete controller bibliography, including all cited keys. The identical final.pdf and final_paper.pdf files are the controller-built manuscript; rebuilding produces main.pdf. See submission-status.json for review status. Build in a separate copy to preserve the reviewed package's ownership hashes.\n`));
  const snapshot = contentManifest(contents);
  if (options.ready) {
    const check = submissionArtifacts(workspace);
    if (!check.passed) throw new Error(`Cannot promote an unvalidated provisional submission: ${check.detail}`);
    if (digestValue(snapshot) !== digestValue(readJson(safeFile(p.runDir, "submission-content.json")))) {
      throw new Error("Submission content changed since review preparation; export review_pending and review again before promotion");
    }
  }
  contents.set("submission-status.json", Buffer.from(`${JSON.stringify({ version: 1,
    status: options.ready ? "completed" : "review_pending", content_sha256: digestValue(snapshot) }, null, 2)}\n`));
  const manifest = contentManifest(contents);
  if (previous && digestValue(previous) === digestValue(manifest)) {
    if (!existsSync(contentPath) || digestValue(readJson(safeFile(p.runDir, "submission-content.json"))) !== digestValue(snapshot)) {
      throw new Error("Existing submission content snapshot is missing or inconsistent");
    }
    return;
  }
  const stage = mkdtempSync(join(p.runDir, "submission-stage-"));
  for (const [rel, content] of contents) {
    const to = assertInside(stage, rel);
    ensureDir(dirname(to));
    writeFileSync(to, content, { flag: "wx" });
  }
  // Preserve complete prior generations. Interrupted swaps fail closed rather than deleting output.
  let archived: string | undefined;
  if (previous) {
    if (digestValue(previous) !== digestValue(contentManifest(submissionContents(output)))) throw new Error("Submission changed during export");
    const history = join(p.runDir, "submission-history");
    assertNoSymlinks(history);
    ensureDir(history);
    const generation = mkdtempSync(join(history, "generation-"));
    writeFileSync(join(generation, "submission.json"), `${JSON.stringify(previous, null, 2)}\n`, { flag: "wx" });
    if (existsSync(contentPath)) writeFileSync(join(generation, "submission-content.json"), readFileSync(safeFile(p.runDir, "submission-content.json")), { flag: "wx" });
    archived = join(generation, "submission");
    renameSync(output, archived);
  }
  try {
    assertNoSymlinks(output);
    if (existsSync(output)) throw new Error("Submission appeared during export");
    renameSync(stage, output);
  } catch (error) {
    if (archived && !lstatSync(output, { throwIfNoEntry: false })) renameSync(archived, output);
    throw error;
  }
  // Do not rewrite the review dependency during a status-only promotion.
  if (!existsSync(contentPath) || digestValue(readJson(contentPath)) !== digestValue(snapshot)) writeSubmissionRecord(contentPath, snapshot);
  writeSubmissionRecord(manifestPath, manifest);
}
