import { execa } from "execa";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import { UnsafePathError } from "./files.js";
import { underForeignDir, underNestedPackage } from "./salience.js";

export const FIGURE_DIR_NAMES = new Set(["figures", "figure", "figs", "fig", "images", "imgs", "plots"]);

const SENSITIVE = [
  /^\.env(?:$|[._-])/i,
  /^\.(?:envrc|npmrc|netrc|pypirc|git-credentials|gitconfig|dockercfg|pgpass|my\.cnf|htpasswd|vault-token|s3cfg|boto|bash_history|zsh_history)$/i,
  /^kubeconfig(?:$|[._-])/i,
  /^(?:auth|credentials?|secrets?|passwords?|api[._-]?keys?|access[._-]?tokens?|refresh[._-]?tokens?)(?:$|[._-])/i,
  /^tokens?(?:\.(?:json|ya?ml|txt|toml|ini))?$/i,
  /(?:^|[._-])(?:credentials?|secrets?|api[._-]?keys?|private[._-]?keys?)(?:$|[._-])/i,
  /^(?:service[._-]?account|client[._-]?secret|application_default_credentials)(?:$|[._-])/i,
  /(^|[._-])(id_rsa|id_ed25519|id_ecdsa|id_dsa)($|[._-])/i,
  /\.(pem|p12|pfx|jks|keystore|key)$/i,
];

// Placeholder suffixes do not establish safety. Topic names such as
// token_efficiency and train_token_amber are not credential filenames.
export function isSensitive(relPath: string): boolean {
  return relPath.split(/[\\/]/).some((name) =>
    /^(?:\.ssh|\.aws|\.azure|\.gcloud|\.kube|\.docker|\.config|\.gnupg|\.direnv|secrets?|credentials?)$/i.test(name) ||
    SENSITIVE.some((re) => re.test(name)));
}

/** Reject traversal and symlinks in every component, not only the leaf. */
export function safeSourcePath(root: string, rel: string): string {
  if (isSensitive(root) || isSensitive(rel)) throw new UnsafePathError(`sensitive source path: ${rel}`);
  if (!rel || rel.includes("\\") || rel.split("/").includes("..") || resolve(rel) === rel) {
    throw new UnsafePathError(`unsafe source path: ${rel}`);
  }
  const base = resolve(root);
  const target = resolve(base, rel);
  if (!relative(base, target) || !target.startsWith(base + sep)) {
    throw new UnsafePathError(`unsafe source path: ${rel}`);
  }
  let current = base;
  if (lstatSync(base).isSymbolicLink()) throw new UnsafePathError("symlink source root");
  for (const part of relative(base, target).split(sep)) {
    current = resolve(current, part);
    const st = lstatSync(current);
    if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) {
      throw new UnsafePathError(`unsafe source entry: ${rel}`);
    }
  }
  if (!lstatSync(target).isFile()) throw new UnsafePathError(`not a source file: ${rel}`);
  return target;
}

export interface PdfInspection {
  role: "research" | "figure" | "manuscript" | "unknown";
  reason: string;
  /** Numeric preview only. Figure assets instead retain a checked PDF. */
  preview?: string;
  sha256?: string;
}

export function isManuscriptPath(rel: string): boolean {
  return /(?:^|[\/_. -])(?:manuscripts?|papers?|submission|camera[_. -]?ready|preprint|thesis|dissertation|draft)(?:$|[\/_. -])/i.test(rel) ||
    /(?:^|\/)final(?:\.[a-z0-9]+|\/|$)/i.test(rel);
}

/** Controller-only classification. Unknown is not a claim that a document is a
 * manuscript. Fail closed on narrative, scans, partial inspection, and errors. */
export function inspectPdf(root: string, rel: string): PdfInspection {
  const file = safeSourcePath(root, rel);
  if (isManuscriptPath(rel)) return { role: "manuscript", reason: "explicit manuscript path; content not inspected" };
  const unknown = (reason: string): PdfInspection => ({ role: "unknown", reason });
  if (lstatSync(file).size > 64 * 1024 * 1024) return unknown("PDF exceeds 64 MiB inspection limit");
  let body: string;
  let pages: number;
  let bytes: Buffer;
  let figureCandidate = false;
  let incomplete = false;
  try {
    // All parser passes and the provenance hash must inspect the same snapshot.
    bytes = readFileSync(file);
    if (bytes.length > 64 * 1024 * 1024) return unknown("PDF exceeds 64 MiB inspection limit");
    const options = { timeout: 15000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" as const,
      input: bytes, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"] };
    const info = execFileSync("pdfinfo", ["-"], { ...options, timeout: 5000, maxBuffer: 64 * 1024 });
    pages = Number(info.match(/^Pages:\s+(\d+)\s*$/m)?.[1]);
    if (!pages || pages > 200) return unknown("PDF page count unavailable or exceeds 200-page inspection limit");
    body = execFileSync("pdftotext", ["-f", "1", "-l", "200", "-layout", "-", "-"], options);
    const pageTexts = body.split("\f");
    incomplete = pageTexts.length < pages || pageTexts.slice(0, pages).some(page => !page.trim());
    figureCandidate = FIGURE_DIR_NAMES.has(basename(dirname(rel)).toLowerCase()) &&
      !underForeignDir(rel) && !underNestedPackage(root, rel);
    if (figureCandidate && /^(?:JavaScript:\s+yes|Form:\s+(?!none\b)\S+)/im.test(info)) {
      return unknown("active PDF content is not a safe figure asset");
    }
  } catch {
    return unknown("PDF extraction failed, unavailable, encrypted, or exceeded limits");
  }
  const lines = body.split(/[\r\n\f]+/).map(line => line.trim()).filter(Boolean);
  const headings = ["abstract", "introduction", "related work", "conclusions?", "references"];
  const found = headings.filter(h => new RegExp(`^\\s*(?:[0-9.]+\\s+)?(?:${h})(?:\\s*[:.]|$)`, "im").test(body));
  if (found.length >= 3 || (found.includes("abstract") && found.includes("introduction"))) {
    return { role: "manuscript", reason: "controller detected manuscript structure; no prose released" };
  }

  if (figureCandidate) {
    if (pages !== 1) return unknown("figure candidate is not single-page; original withheld");
    const labelsOnly = body.trim().length <= 800 && body.trim().split(/\s+/).length <= 80 && lines.length <= 60 &&
      lines.every(line => line.length <= 80 && line.split(/\s+/).length <= 8 && !/[.!?](?:\s|$)/.test(line));
    if (!labelsOnly || found.length > 0) return unknown("figure candidate contains narrative or manuscript headings; original withheld");
    try {
      // Inspect rendered vector structure, not PDF stream regexes (which miss
      // compressed graphics). Raster-only pages remain unknown: they may be scans.
      const svg = execFileSync("pdftocairo", ["-svg", "-f", "1", "-l", "1", "-", "-"], {
        timeout: 15000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8", input: bytes, stdio: ["pipe", "pipe", "pipe"],
      });
      const drawing = svg.replace(/<defs\b[^>]*>[\s\S]*?<\/defs>/g, "");
      const shapes = drawing.match(/<(?:path|rect|circle|ellipse|polyline|polygon)\b[^>]*>/g) ?? [];
      const stroked = shapes.some(shape => /(?:stroke:|stroke=")[^;"\s]+/.test(shape) && !/stroke[:=]["\s]*none/.test(shape));
      if (!/<svg\b/.test(svg) || /<image\b/.test(svg) || !stroked || shapes.length > 2000) {
        return unknown("figure candidate lacks bounded vector-graphic structure or contains raster imagery; original withheld");
      }
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      return { role: "figure", sha256, reason: "authored single-page vector figure; bounded labels and graphics, no manuscript prose detected" };
    } catch { return unknown("figure structure inspection failed, unavailable, or exceeded limits"); }
  }
  if (incomplete) return unknown("PDF has pages without extractable text; inspection is incomplete");
  if (lines.length === 0) return unknown("PDF has no extractable text; scanned/graphical evidence needs a safe extractor");

  const number = "[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?%?";
  const row = new RegExp(`^(?:[A-Za-z][\\w./%-]{0,31}\\s+)?${number}(?:[\\t ,;]+${number})+$`);
  const metric = new RegExp(`^[A-Za-z][\\w./%-]{0,31}\\s*[:=]\\s*${number}(?:\\s+(?:ms|s|us|ns|Hz|MHz|GHz|mm|cm|m|nm|K|MB|GB|W|J|%))?$`);
  const numericRows = lines.filter(line => line.length <= 240 && (row.test(line) || metric.test(line)));
  const numericSet = new Set(numericRows);
  // A name such as appendix.pdf or ray-trace-data.pdf neither permits nor
  // prevents admission. Positive numeric structure, not a filename, is needed.
  // Only short labels/page numbers may accompany the rows; prose stays unknown.
  const other = lines.filter(line => !numericSet.has(line));
  const shortLabelsOnly = other.every(line => line.length <= 100 &&
    line.split(/\s+/).length <= 10 && /^[\w\s()[\]/%+:,=-]+$/.test(line));
  if (numericRows.length < 2 || !shortLabelsOnly || other.length > Math.max(4, numericRows.length)) {
    return unknown("ambiguous PDF: not established as raw empirical data; original and prose quarantined outside writer workspace");
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const preview = `# Controller PDF numeric preview\n\nSource: ${JSON.stringify(rel)}\nSHA256: ${sha256}\n` +
    "Extractor: pdf-numeric-v1\n\n" +
    "Data-like text detected by a heuristic, not proof of document origin. Original PDF and narrative text withheld.\n" +
    `Numeric rows detected: ${numericRows.length}; previewed: ${Math.min(numericRows.length, 200)}.\n` +
    "Partial evidence only: at most 200 numeric rows; labels, units, figures, and context may be missing.\n" +
    "Do not infer column meanings or claim evidence sufficiency from this preview; resolve them from independent raw records.\n\n```text\n" +
    numericRows.slice(0, 200).join("\n") + "\n```\n";
  return { role: "research", reason: "data-like numeric content detected; only a partial numeric preview is released", preview, sha256 };
}

export const EXTRACTABLE = new Set([
  ".ipynb", ".sqlite", ".sqlite3", ".db", ".csv", ".tsv", ".json", ".jsonl", ".ndjson", ".npy", ".npz",
]);

// Shipped as a string so tsc includes the controller-owned extractor in dist.
// No project imports, notebook execution, pickle loading, shell or SQL supplied
// by the input. Limits apply independently of the model's instructions.
const PYTHON = String.raw`
import sys, os, json, csv, sqlite3, math, zipfile
from pathlib import Path
try:
    import resource
    resource.setrlimit(resource.RLIMIT_CPU, (8, 8))
    resource.setrlimit(resource.RLIMIT_AS, (1024**3, 1024**3))
except (ImportError, ValueError, OSError):
    pass
p = Path(sys.argv[1])
ext = p.suffix.lower()
LIMIT = 200
def compact(v):
    if isinstance(v, dict):
        return {str(k)[:200]: compact(x) for k,x in list(v.items())[:40]}
    if isinstance(v, list):
        return [compact(x) for x in v[:20]]
    if isinstance(v, str): return v[:1000]
    if isinstance(v, bytes): return '<binary: %d bytes>' % len(v)
    return v
def rows_summary(rows):
    stats = {}
    for row in rows:
        if not isinstance(row, dict): continue
        for key, val in row.items():
            try: n = float(val)
            except (TypeError, ValueError, OverflowError): continue
            if math.isfinite(n): stats.setdefault(str(key), []).append(n)
    return {'sample_rows': len(rows), 'preview': compact(rows[:10]),
            'numeric_sample_summary': {k: {'count': len(v), 'min': min(v), 'max': max(v),
              'mean': sum(x / len(v) for x in v)} for k,v in stats.items()}}
if ext in ('.sqlite', '.sqlite3', '.db'):
    db = sqlite3.connect(p.as_uri() + '?mode=ro&immutable=1', uri=True)
    db.execute('PRAGMA query_only=ON')
    db.execute('PRAGMA trusted_schema=OFF')
    def authorize(action, table, column, database, trigger):
        if action == sqlite3.SQLITE_READ and any(word in (column or '').lower() for word in ('credential', 'secret', 'password', 'api_key', 'access_token', 'refresh_token')):
            return sqlite3.SQLITE_IGNORE
        return sqlite3.SQLITE_OK
    db.set_authorizer(authorize)
    ticks = [0]
    def progress():
        ticks[0] += 1
        return ticks[0] > 10000
    db.set_progress_handler(progress, 1000)
    tables = db.execute("SELECT name, sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 21").fetchall()
    result = {'tables': [], 'note': 'Read-only immutable snapshot; uncheckpointed WAL is not included. At most 20 ordinary tables and 200 rows/table; no views or virtual tables. Credential-named columns are replaced with null by the SQL authorizer, without reading their values.'}
    for name, sql in tables[:20]:
        if any(word in name.lower() for word in ('credential', 'secret', 'password', 'auth', 'token', 'api_key')):
            result['tables'].append({'name': name, 'excluded': 'credential table; rows not read'})
            continue
        if not sql or 'VIRTUAL' in sql.upper(): continue
        quoted = '"' + name.replace('"', '""') + '"'
        cur = db.execute('SELECT * FROM ' + quoted + ' LIMIT 200')
        columns = [d[0] for d in cur.description]
        rows = [dict(zip(columns, row)) for row in cur.fetchall()]
        result['tables'].append({'name': name, 'columns': columns, **rows_summary(rows)})
    db.close()
elif ext in ('.npy', '.npz'):
    import numpy as np
    if ext == '.npz':
        with zipfile.ZipFile(p) as z:
            if len(z.infolist()) > 20 or sum(i.file_size for i in z.infolist()) > 64*1024*1024:
                raise ValueError('array archive exceeds expansion limit')
    data = np.load(p, allow_pickle=False, mmap_mode='r' if ext == '.npy' else None)
    arrays = [(k, data[k]) for k in data.files[:20]] if ext == '.npz' else [('array', data)]
    result = {'arrays': [], 'note': 'Statistics use at most the first 10000 values; pickle/object arrays are never loaded.'}
    for name, a in arrays:
        sample = a.reshape(-1)[:10000]
        item = {'name': name, 'shape': list(a.shape), 'dtype': str(a.dtype), 'size': int(a.size), 'sample_size': int(sample.size)}
        if np.issubdtype(a.dtype, np.number) and not np.iscomplexobj(a):
            finite = sample[np.isfinite(sample)].astype(float)
            if finite.size: item.update(min=float(finite.min()), max=float(finite.max()), mean=float(finite.mean()))
        item['preview'] = compact(sample[:20].tolist())
        result['arrays'].append(item)
elif ext in ('.csv', '.tsv'):
    with p.open(encoding='utf-8-sig', newline='') as f:
        reader = csv.DictReader(f, delimiter='\t' if ext == '.tsv' else ',')
        rows = []
        for row in reader:
            rows.append(row)
            if len(rows) >= LIMIT: break
        result = {'columns': reader.fieldnames, **rows_summary(rows)}
else:
    if p.stat().st_size > 16*1024*1024: raise ValueError('structured text exceeds 16 MiB parse limit')
    with p.open(encoding='utf-8') as f:
        if ext in ('.jsonl', '.ndjson'):
            rows = []
            for line in f:
                if line.strip(): rows.append(json.loads(line))
                if len(rows) >= LIMIT: break
            result = rows_summary(rows)
        else:
            data = json.load(f)
            if ext == '.ipynb':
                cells = data.get('cells', [])
                result = {'cell_count': len(cells), 'cells': [], 'note': 'Saved cells and outputs only; no cells executed. At most 200 cells.'}
                for index, cell in enumerate(cells[:LIMIT]):
                    outputs = []
                    for out in cell.get('outputs', [])[:10]:
                        text = out.get('text', out.get('data', {}).get('text/plain', []))
                        outputs.append(compact(text))
                    result['cells'].append({'index': index, 'type': cell.get('cell_type'), 'source': compact(cell.get('source', [])), 'saved_outputs': outputs})
            else:
                result = rows_summary(data[:LIMIT]) if isinstance(data, list) else {'preview': compact(data)}
rendered = json.dumps(result, ensure_ascii=True, allow_nan=False)
print(rendered if len(rendered) <= 48000 else json.dumps({'truncated': True, 'preview': rendered[:46000]}))
`;

export async function extractData(root: string, rel: string): Promise<string> {
  const file = safeSourcePath(root, rel);
  if (!EXTRACTABLE.has(extname(rel).toLowerCase())) throw new Error("unsupported extractor");
  const { stdout } = await execa("python3", ["-I", "-c", PYTHON, file], {
    cwd: "/", timeout: 15000, maxBuffer: 128 * 1024,
    extendEnv: false,
    env: { PATH: process.env.PATH, OPENBLAS_NUM_THREADS: "1", OMP_NUM_THREADS: "1" },
  });
  return `# Controller extraction\n\nSource: ${JSON.stringify(rel)}\nExtractor: python-data-v1\n\n` +
    "Bounded preview, not an exhaustive result. Sample statistics are not full-dataset statistics.\n" +
    "Input code was not executed. Missing or truncated values must not be inferred.\n\n```json\n" + stdout + "\n```\n";
}
