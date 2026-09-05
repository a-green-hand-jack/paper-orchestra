# Developer User Simulation

Develop PaperOrchestra by using it as an installed CLI, not by substituting mock
models or unit tests for the user's workflow. Edit the current source, rebuild,
and run the packaged CLI with real materials, actual provider identities and
online services. There is no tracked `tests/` suite and none should be recreated
elsewhere. `npm run typecheck` and `npm run build` remain useful credential-free
development checks; `npm test` is real Docker manuscript acceptance.

## Build and Iterate

Run as a non-root host user with Docker/BuildKit access and Node >=20:

```bash
npm run test:docker -- build
npm run test:docker -- tools
```

Every harness invocation rebuilds **the current working copy**, including
uncommitted source changes, as `paper-orchestra:e2e` (override `PO_DOCKER_IMAGE`).
Docker caches dependencies but rebuilds changed source. The build does `npm ci`,
TypeScript build, shrinkwrap from the lock, `npm pack`, and a global installation
of that tarball in the runtime stage. No host `dist/`, `node_modules/`, Python
executable, output, dataset, Git history, or credential profile enters the image.

The runtime includes Node 22.22.0, official `opencode-ai@1.18.29`,
`@openai/codex@0.153.4`, `@dptech-corp/bohr-cli@2.6.86`, and the native Python
`huggingface_hub==1.30.0` CLI in `/opt/hf`, exposed as `/usr/local/bin/hf`.
System Python retains NumPy/Matplotlib for the real plotting/extraction route.
TeX, BibTeX, Biber, latexmk and Poppler are installed from the dated, signed
Debian snapshot in `Dockerfile`. npm uses `https://registry.npmjs.org`, HF uses
`https://pypi.org/simple` with transitive pins in `docker/hf-constraints.txt`;
dependency inventories are under `/opt/package/`.
The optional OAuth provider resolves the pinned `@ai-sdk/openai@3.0.84` from
image-owned `/opt/node_modules`; no host Node dependencies are mounted. Its
resolved inventory is `/opt/package/provider-packages.json`.
Retain the recorded image ID to reuse an exact environment; remote model behavior
and remote services are not frozen by package versions.

`tools` mounts no identities and performs no model prompts or paid searches.
It checks executables/imports and calls the actual doctor. Missing authentication
is a real failure, not a synthetic passing check. A version/help result proves
installation only, **not authenticated service usability**.

## Networking and Isolation

**The default is ONLINE: `--network=bridge`.** This applies to user simulation,
`services`, `exec`, and `tools`. Select a custom named network with
`PO_DOCKER_NETWORK`; `none` is available only when explicitly requested. Host
networking and container-network sharing are refused. The additional independent
submission rebuild is deliberately offline, not the user's normal workflow.

Runtime uses the host's non-root UID/GID, read-only image filesystem, dropped
capabilities, no-new-privileges, 4 CPUs, 8 GiB RAM and 512 processes. Writable
HOME and `/tmp` are disposable tmpfs. Only a dedicated output directory is
host-writable. No host HOME, root directory, repository, host Python executable,
Docker socket or host ports are exposed. Do not run the harness as root.

Default research mounts are the existing selected raw-only Gewu preparation:

| Host selection | Container destination |
|---|---|
| `datasets/gewu-issue48/input` or `PO_MATERIALS_DIR` | `/materials`, read-only |
| `datasets/gewu-issue48/benchmark/gewu-kerr-no-assets/instruction.md` or `PO_BRIEF_FILE` | `/run/brief.md`, read-only |
| Fresh `docker-output/<UTC-timestamp>-<pid>/` or `PO_OUTPUT_DIR` | `/output`, writable |

There is no dataset download during build or acceptance setup. Only the prepared
raw selection is mounted, not prior runs or finished papers. The brief prohibits
retrieving finished manuscripts, reconstructing source papers and running new
simulations. Override materials only with another sanitized research selection.

## Mounted Identities

The launcher discovers only standard identity paths when explicit overrides are
absent: bohr uses `BOHR_CONFIG_DIR` or `~/.bohr-cli` when `config.yaml` exists;
HF uses `HF_HOME` or `~/.cache/huggingface` when `token` exists. Discovery checks
paths only, never prints or opens secret contents on the host. Use `PO_*`
overrides below for nonstandard installations. These mounts simulate the
developer's authenticated user workflow; accounts never enter image layers.

The primary/operator first confirms **paths**, without printing or reading secret
contents. Set the following path variables in the invoking environment. The host
harness checks paths/types only; runtime CLIs consume the identities. Never pass
keys/tokens as command arguments, build args, repository files or plaintext logs.
Never mount a whole HOME or broad `.config` directory.

| Setting | Read-only mount | Writable runtime use |
|---|---|---|
| `PO_BOHR_CONFIG_DIR` | `/run/secrets/bohr-profile` | Copies the selected profile to `/home/runner/.bohr`, set as `BOHR_CONFIG_DIR` |
| `PO_LKM_KEY_FILE` | `/run/secrets/lkm-key` | Optional alternative/override: runtime-only `BOHR_ACCESS_KEY` |
| `PO_HF_HOME` | Only `token` and optional `stored_tokens` as individual `/run/secrets/hf-*` mounts | Copies into tmpfs `/home/runner/.cache/huggingface` (`HF_HOME`) |
| `PO_HF_TOKEN_FILE` | `/run/secrets/hf-token` | Overrides `PO_HF_HOME/token`; copied to runtime `HF_TOKEN_PATH` |
| `PO_TEXT_CONFIG_FILE` | `/run/secrets/text-config.json` | Secret-free JSON selected by `OPENCODE_CONFIG` |
| `PO_MODEL_KEY_FILE` | `/run/secrets/model-key` | Optional runtime-only `PO_MODEL_KEY` for `{env:PO_MODEL_KEY}` references |
| `PO_OAUTH_PROVIDER_FILE` | `/opt/po-provider/codex-oauth.mjs` | Optional single secret-free governed provider implementation; read-only |
| `PO_TEXT_AUTH_FILE` | `/run/secrets/text-auth.json` | Selected text-provider Codex OAuth identity; read-only, provider refreshes in memory |
| `PO_CODEX_AUTH_FILE` | `/run/secrets/codex-auth.json` | Copies OAuth state into tmpfs `/home/runner/.codex/auth.json` |

bohr 2.6.86 supports `BOHR_CONFIG_DIR`; select its actual narrow configuration
directory, not a guessed legacy path. Its pinned binary contains that override
and `.bohr` conventions. HF 1.30.0's official `constants.py` defines `HF_HOME`
(normally `~/.cache/huggingface`, respecting `XDG_CACHE_HOME`), `HF_TOKEN_PATH`
(normally `HF_HOME/token`) and sibling `stored_tokens`. HF data/model caches are
not identity requirements and are **not mounted**. A host `hf` launcher alone
is not portable; the container always executes its own installed HF CLI.

bohr profile copying refuses links/special files, limits depth/files/size, and
excludes tools, extensions, cache, logs and Git data. Profile refresh, token
switches and OAuth refresh affect only tmpfs copies. Nothing syncs back to host
identities; refresh the host login separately when needed. The active bohr
profile is preserved; `exec -- bohr --profile NAME ...` can select another one.

Use `docker/opencode.example.json` as a **secret-free template**, replacing its
placeholder HTTPS provider endpoint and model ID/limits with the approved text
provider's configuration. Set `PO_MODEL=provider/model[:variant]`. Visual reviews
require image input support. Do not mount the full host OpenCode plugin/config
tree. HF talks to `https://huggingface.co`; bohr's default service is
`https://open.bohrium.com`; custom profile endpoints must be trusted by the user.
Codex images use the official ChatGPT OAuth route, separately from the text API.

### Governed Text OAuth

As an alternative to the API-key template, use `docker/opencode.oauth.example.json`
with `PO_MODEL=acceptance/gpt-5.6-sol:medium` (or `:high`). It declares text/image
input, a 1M-token context and 128k output ceiling. These are model configuration
limits, not permission to exceed the run budgets or a guarantee of account access.
No API key is required for this route.

Set **both** `PO_OAUTH_PROVIDER_FILE` and `PO_TEXT_AUTH_FILE`; incomplete pairs
fail before the container starts. The module must be secret-free, export
`createCodexOAuth(options)`, accept `options.authFile`, import only the installed
`@ai-sdk/openai` dependency, and refresh in memory without writing the auth file.
Use the approved governed module, not an arbitrary downloaded plugin. The tiny
repository-owned `/opt/po-provider/provider.mjs` re-exports that mounted factory.
Neither the module nor its identity is copied into an image layer or repository.

Example invocation parameters (replace only with the primary's confirmed paths):

```bash
PO_MODEL=acceptance/gpt-5.6-sol:medium \
PO_TEXT_CONFIG_FILE="$PWD/docker/opencode.oauth.example.json" \
PO_OAUTH_PROVIDER_FILE=/absolute/approved/provider-module.mjs \
PO_TEXT_AUTH_FILE=/absolute/selected/text-oauth.json \
PO_CODEX_AUTH_FILE=/absolute/selected/image-oauth.json \
PO_ALLOW_PAID=1 npm test
```

bohr/HF retain standard path discovery and explicit overrides described above.
Text and image OAuth paths are selected independently; they may point to the same
approved identity but neither is inferred from the other. The runtime writes only
a fresh tmpfs Codex `config.toml` with `[features] image_generation = true`, so
auth-only mounting does not leave the real image feature disabled. It never
copies host Codex configuration. Acceptance runs `doctor --model "$PO_MODEL"`
before writing, so custom configured providers need not appear in the built-in
OpenCode credential listing. No paid text call is implied by a successful doctor.

## Real Service Checks

Authenticated checks were executed successfully in the container on 2026-09-05:
bohr identity and account reads, HF identity and pinned Gewu metadata, plus a
real `hf download` of that revision's README. Evidence is recorded under
`docker-output/2026-09-05T19-09-59-224Z-2687834/` and
`docker-output/2026-09-05T19-22-15-611Z-2754354/` on the development workspace.
These are service/user-command results, not a claim that manuscript acceptance
has passed. Reports keep `manuscript_accepted` separate from the requested
command's `ok` result.

```bash
npm run test:docker -- services
npm run test:docker -- exec -- hf download Jack-Jieke-Wu/Gewu-Solutions README.md \
  --type dataset --revision 576302afd4bc95cd3b3ed809f4822c611a1ea95f \
  --local-dir /output/hf-download
```

After the primary has confirmed a bohr profile/key and HF home/token path:

```bash
npm run test:docker -- services
```

This executes the following actual installed commands online, with 60 seconds
and 4 MiB captured-output bounds per command:

```bash
bohr auth whoami --no-interactive -o json
bohr billing balance --no-interactive -o json
hf auth whoami --format json
hf datasets info Jack-Jieke-Wu/Gewu-Solutions \
  --revision 576302afd4bc95cd3b3ed809f4822c611a1ea95f \
  --expand sha --format json
```

These are identity/account/metadata reads, not LKM searches, image generation,
compute jobs, downloads of full data or paid model calls. The bohr account read
must return a successful API envelope; the HF identity must be present, and the
dataset ID/revision must match. Raw identities, balances, tokens, signed URLs and
API errors are discarded. `services-acceptance.json` records sanitized outcomes
only, plus the successful allowlisted Gewu dataset ID and revision. Missing
profiles, denied access or network failure fail, never fall back to anonymous
identity success. No successful authenticated check is claimed until it runs.

Verified service evidence: the primary's 2026-09-05 online run recorded all four
checks passing, with exit 0 and the pinned dataset ID/revision matched, in
`docker-output/2026-09-05T19-09-59-224Z-2687834/acceptance.json`.
It used the narrow standard bohr and HF identity mounts. No private account name,
token or balance is reproduced here. This verifies those service reads, not text
OAuth generation, image generation or manuscript acceptance.

## Individual User Commands

```bash
npm run test:docker -- exec -- bohr auth whoami -o json
npm run test:docker -- exec -- hf datasets info Jack-Jieke-Wu/Gewu-Solutions --expand sha
npm run test:docker -- exec -- paper-orchestra doctor
PO_OUTPUT_DIR=/absolute/previous-output npm run test:docker -- exec -- \
  paper-orchestra status /output/workspace --json
```

`exec` uses the same installed image, online network, mounts and isolated identity
setup. Only `bohr`, `hf` and `paper-orchestra` entry points are accepted; arguments
are passed as an argv array, not through a shell. Supplied CLI flags determine the
action; **exec is not a read-only API allowlist or a spending authorization**.
Only invoke actions the user authorized. The dedicated `services` mode is the
bounded no-spend verification path. CLI authentication remains real and fails
normally when its necessary mounted identity is absent.

For a custom text provider, use `paper-orchestra doctor --model provider/model`.
This checks configured model visibility without requiring an unrelated built-in
OpenCode auth-store entry; the actual writing request verifies authentication.
Output overrides must not overlap materials, providers or identity paths, and
repository-local outputs must be dedicated children of `docker-output/`.

To keep credentials out of logs, exec discards raw stdout/stderr and does not
record argument values. `exec-acceptance.json` records exit status and elapsed
time; inspect deliberate CLI-produced research artifacts under `/output`.
Existing dedicated output is allowed only for explicit `exec` or `resume`;
prior top-level acceptance records are archived before a new attempt.

## Manuscript Acceptance

With model, text config, Codex OAuth and bohr profile/key configured:

```bash
PO_ALLOW_PAID=1 npm test
PO_ALLOW_PAID=1 PO_OUTPUT_DIR=/absolute/previous-output npm run test:docker -- resume
```

Fresh acceptance runs the same installed CLI through doctor, autonomous headless
write, status and validate. Writing must complete, report `submission_ready`,
and export actual LaTeX/bibliography/figures/PDF. A separate, credential-free,
network-disabled container copies that export and recompiles from source without
prebuilt main PDFs or shell escape, then reads the new PDF with Poppler. That
additional portability check does not replace real online user behavior or human
scientific/visual review.

| Run setting | Default | CLI flag |
|---|---|---|
| `PO_MAX_TOTAL_TOKENS` | 8000000 | `--max-total-tokens` |
| `PO_MAX_TOTAL_COST` | 100 USD known model cost | `--max-total-cost` |
| `PO_MAX_MODEL_CALLS` | 80 | `--max-model-calls` |
| `PO_MAX_IMAGE_CALLS` | 12 | `--max-image-calls` |
| `PO_MAX_OPERATION_CALLS` | 64 | `--max-operation-calls` |
| `PO_MAX_RUN_MINUTES` | 120 | `--max-run-minutes` |
| `PO_MAX_LKM_CALLS` | 10 | `--max-lkm-calls` |
| `PO_TARGET_CITATIONS` | 5 | `--target-citations` |
| `PO_RESEARCH_CUTOFF` | 2026-09 | `--research-cutoff` |
| `PO_TIMEOUT_MULTIPLIER` | 1 | `--timeout-multiplier` |

All six whole-run budgets are passed explicitly on fresh acceptance writes.
Resume preserves locked scope and consumed budgets. An explicitly supplied
`PO_MAX_TOTAL_TOKENS` on resume is forwarded as `--max-total-tokens` and may only
increase the effective token ceiling. Omission never raises it automatically.
The budget ledger records the increase and retains every usage counter; its
`limits` field is the effective budget, while run scope retains the initial
configuration. Other limits are unchanged. For example, with the usual model
and identity settings configured:

```bash
PO_ALLOW_PAID=1 PO_MAX_TOTAL_TOKENS=16000000 \
  PO_OUTPUT_DIR=/absolute/previous-output npm run test:docker -- resume
```

`exec` passes exactly the
user's argv; supply budget CLI flags there as for an ordinary installed user.
`PO_TIMEOUT_SECONDS` defaults to 7200 (60-86400), an outer command deadline in
addition to CLI budgets. Known model cost is not a total invoice guarantee;
unreported image/provider charges are not free. Use provider-side monetary caps.
Only `PO_ALLOW_PAID=1` enables the harness's paid writing path; service checks do
not require it and never call LKM retrieval.

## Evidence and Failures

`acceptance.json` outside the container records image identity, online network,
mount destinations/settings without secret contents, budgets, outcomes and time.
`ok` and `command_ok` report mode-specific success; `manuscript_accepted` is true
only after full writing and independent recompilation. Build/tools/services/exec
never claim manuscript success.
`runtime-acceptance.json` records writing-stage outcomes and validation;
`recompile-*/` holds the separate PDF build evidence. Failure exit codes survive;
timeouts fail and trigger container shutdown. Research outputs and the CLI's own
workspace provenance remain private. Sanitized harness records do not promise
that arbitrary user-generated artifacts are secret-free.

Do not infer a successful real service check from `--version`, a successful image
build, a dummy key, an empty profile, or a cached/fabricated response. During
implementation, do not mount live profiles until the primary confirms the paths.
