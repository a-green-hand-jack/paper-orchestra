import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { figurePublicationName, renderFigure, resolveFigureRoute } from "../dist/figures.js";

function fixture(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "po-figures-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "measurements.csv");
  writeFileSync(path, "step,value\n1,7\n2,19\n3,23\n");
  return { root, path, workDir: join(root, "render") };
}

test("quantitative plots cannot route to text-to-image", () => {
  for (const render_route of [undefined, "auto", "code", "text_to_image"]) {
    assert.equal(resolveFigureRoute({ plot_type: "plot", render_route }), "code");
  }
  assert.equal(resolveFigureRoute({ plot_type: "diagram" }), "text_to_image");
  assert.equal(resolveFigureRoute({ plot_type: "diagram", render_route: "code" }), "code");
});

test("publication names reject unsafe IDs and extensions", () => {
  assert.equal(figurePublicationName("results_1-a"), "results_1-a.pdf");
  assert.equal(figurePublicationName("overview", ".png"), "overview.png");
  for (const id of ["", "../escape", "/absolute", "a/b", "a\\b", ".", "a.pdf", "a\n", "1plot"]) {
    assert.throws(() => figurePublicationName(id), /unsafe/);
  }
  assert.throws(() => figurePublicationName("plot", "../x"), /unsafe/);
});

test("real Python renders numeric CSV inputs without inherited credentials or startup hooks", async (t) => {
  const { root, path, workDir } = fixture(t);
  const hook = join(root, "hooks");
  mkdirSync(hook);
  writeFileSync(join(hook, "sitecustomize.py"), "raise RuntimeError('inherited startup hook')\n");
  const keys = ["PO_TEST_AUTH_TOKEN", "PYTHONPATH", "HTTP_PROXY"];
  const previous = keys.map((key) => process.env[key]);
  process.env.PO_TEST_AUTH_TOKEN = "synthetic-not-a-credential";
  process.env.PYTHONPATH = hook;
  process.env.HTTP_PROXY = "http://127.0.0.1:1";
  t.after(() => keys.forEach((key, i) => {
    if (previous[i] === undefined) delete process.env[key];
    else process.env[key] = previous[i];
  }));
  const result = await renderFigure({
    figureId: "numeric", workDir,
    dataFiles: [{ path, name: "experiment/measurements.csv" }],
    code: `import csv, os, socket
import matplotlib.pyplot as plt
assert 'PO_TEST_AUTH_TOKEN' not in os.environ
assert 'HTTP_PROXY' not in os.environ
assert os.environ['HOME'] == os.getcwd()
assert os.environ['PYTHONPATH'].split(os.pathsep)[0] == os.getcwd()
try:
    socket.create_connection(('127.0.0.1', 1))
except RuntimeError as error:
    assert 'network disabled' in str(error)
else:
    raise AssertionError('network guard missing')
with open('data/experiment/measurements.csv') as source:
    rows = list(csv.DictReader(source))
x = [int(row['step']) for row in rows]
y = [int(row['value']) for row in rows]
with open('read-values.txt', 'w') as evidence:
    evidence.write(','.join(map(str, y)))
plt.plot(x, y)
plt.savefig('numeric.pdf')`,
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(readFileSync(join(workDir, "read-values.txt"), "utf8"), "7,19,23");
  assert.equal(readFileSync(result.imagePath).subarray(0, 5).toString(), "%PDF-");
  assert.equal(readFileSync(join(workDir, "data/experiment/measurements.csv"), "utf8"), readFileSync(path, "utf8"));
});

test("unsafe inputs fail before clearing outputs or executing Python", async (t) => {
  const { root, path, workDir } = fixture(t);
  mkdirSync(workDir);
  const marker = join(workDir, "keep.csv");
  writeFileSync(marker, "preserve");
  symlinkSync(path, join(root, "linked.csv"));
  symlinkSync(root, join(root, "linked-dir"));
  const invalid = [
    ...["../escape", "/absolute", "a/../../escape", "a\\b", "C:/x", "a//b", "./a", "a/", "a\u0000b"].map((name) => [{ path, name }]),
    [{ path: "relative.csv", name: "x.csv" }],
    [{ path: join(root, "linked.csv"), name: "x.csv" }],
    [{ path: join(root, "linked-dir", "measurements.csv"), name: "x.csv" }],
    [{ path: root, name: "x.csv" }],
    [{ path: marker, name: "x.csv" }],
    [{ path, name: "x.csv" }, { path, name: "x.csv" }],
    [{ path, name: "X.csv" }, { path, name: "x.csv" }],
    [{ path, name: "nested" }, { path, name: "nested/x.csv" }],
  ];
  for (const dataFiles of invalid) {
    const result = await renderFigure({ figureId: "safe", workDir, dataFiles, code: "raise Exception('executed')" });
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.error, /executed/);
    assert.equal(readFileSync(marker, "utf8"), "preserve");
  }
  const invalidId = await renderFigure({ figureId: "../escape", workDir, code: "print('executed')" });
  assert.match(invalidId.error, /unsafe figure ID/);
  assert.equal(readFileSync(marker, "utf8"), "preserve");
});

test("data inputs do not bypass the existing generated-script guard", async (t) => {
  const { path, workDir } = fixture(t);
  const result = await renderFigure({ figureId: "safe", workDir,
    dataFiles: [{ path, name: "values.csv" }], code: "import subprocess" });
  assert.equal(result.ok, false);
  assert.match(result.error, /subprocess call/);
  assert.match(result.error, /relative data\/<name>/);
});
