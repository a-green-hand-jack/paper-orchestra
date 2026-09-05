"""Harbor agent adapter for PaperOrchestra.

PaperOrchestra is a pipeline, not a chat agent: a controller drives fixed
stages, validators decide when each one is done, and the model is only ever
asked for the parts that need judgement. Harbor's contract fits it directly --
one location plus one instruction -- and running it this way is what keeps the
measurement honest, because a container hands the agent `/workspace` and no
opportunity for anyone to tidy the input first.

The adapter does mechanical work only: install, credentials, invoke, and map
the workspace onto the task's submission contract. It deliberately does NOT
prepare the input. If it ever seems to need to -- to point at a template, to
name a document, to write a guidelines file -- that is a capability missing
from PaperOrchestra, and it belongs there rather than here.
"""

from __future__ import annotations

import json
import os
import shlex
import subprocess
import tempfile
from pathlib import Path

from typing_extensions import override

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

REPO_ROOT = Path(__file__).resolve().parent.parent

#: Where PaperOrchestra builds its workspace. Inside `/workspace` so the run's
#: own git branch, checkpoints and artifacts come back with the trial, but
#: named with the `po-run-` prefix that the material walk already skips -- so
#: a resumed or repeated run never imports its predecessor as source material.
WORKSPACE = "/workspace/po-run-harbor"

#: OpenCode reads credentials from `$XDG_DATA_HOME/opencode/auth.json`.
REMOTE_AUTH = "/root/.local/share/opencode/auth.json"


def _host_auth_json() -> Path | None:
    """The host's OpenCode credentials, if this machine has any."""
    base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    candidate = Path(base) / "opencode" / "auth.json"
    return candidate if candidate.is_file() else None


#: The variable the `bohr` CLI actually reads. Measured, not guessed: with only
#: `BOHRIUM_ACCESS_KEY` set, `bohr auth status` reports `logged_in: false`; with
#: `BOHR_ACCESS_KEY` it reports `auth_method: access_key, logged_in: true` and a
#: real `lkm search` succeeds. The adapter used to forward the former, so the
#: literature stage's paid path could not have authenticated at all.
BOHR_ACCESS_KEY_ENV = "BOHR_ACCESS_KEY"

#: Where the CLI keeps that key when a human ran `bohr auth login`.
BOHR_CLI_CONFIG = Path.home() / ".bohr-cli" / "config.yaml"


def _host_bohr_access_key() -> str | None:
    """The Bohrium access key this machine can offer, or None.

    Read from the environment first, then from the file `bohr auth login`
    writes. Only the key travels -- never the OAuth token file beside it, which
    expires and which nothing here needs.
    """
    from_env = os.environ.get(BOHR_ACCESS_KEY_ENV) or os.environ.get("BOHRIUM_ACCESS_KEY")
    if from_env:
        return from_env.strip()
    try:
        text = BOHR_CLI_CONFIG.read_text()
    except OSError:
        return None
    for line in text.splitlines():
        key, _, value = line.partition(":")
        if key.strip() == "access_key" and value.strip():
            return value.strip()
    return None


def _as_bool(value: bool | str) -> bool:
    """Harbor passes `--ak key=value` as strings, so "false" must not be true."""
    if isinstance(value, bool):
        return value
    return value.strip().lower() in {"1", "true", "yes", "on"}


class PaperOrchestra(BaseInstalledAgent):
    """Run the PaperOrchestra writing pipeline inside a Harbor task."""

    def __init__(
        self,
        *args,
        allow_lkm_spend: bool | str = False,
        max_lkm_calls: int | str | None = None,
        target_citations: int | str | None = None,
        research_cutoff: str | None = None,
        **kwargs,
    ):
        """Accept the knobs a Harbor job needs, via `--ak key=value`.

        `allow_lkm_spend` defaults to FALSE, matching the CLI's own posture:
        retrieval costs real money per call, so it is authorized per invocation
        rather than implied by running at all. A task whose materials already
        carry a bibliography never reaches the paid path anyway.

        `target_citations` is here because it is the one knob that visibly moves
        the official metric: the default of 20 is a floor, and one graded task's
        reference paper cites 47, so a job comparing against that can raise it
        without patching the product.
        """
        super().__init__(*args, **kwargs)
        self.allow_lkm_spend = _as_bool(allow_lkm_spend)
        self.max_lkm_calls = None if max_lkm_calls is None else int(max_lkm_calls)
        self.target_citations = None if target_citations is None else int(target_citations)
        # A task can intend a research cutoff -- one corpus config exports
        # PAPER_ORCHESTRA_RESEARCH_CUTOFF=2024-10-01 from its own entrypoint,
        # because reconstructing a paper means citing what existed when it was
        # written. PaperOrchestra defaults to the current month, which would
        # admit work published years after the paper under reconstruction, so
        # the job needs a way to say otherwise.
        self.research_cutoff = research_cutoff

    @staticmethod
    @override
    def name() -> str:
        return "paper-orchestra"

    @override
    def get_version_command(self) -> str | None:
        return '. ~/.nvm/nvm.sh 2>/dev/null; paper-orchestra --version'

    # -- install ------------------------------------------------------------

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(
            environment,
            # `git` for the per-stage checkpoints, `poppler-utils` for
            # `pdftotext`, which PaperOrchestra requires rather than probes:
            # it converts any PDF in the materials into readable text.
            command="apt-get update && apt-get install -y curl git poppler-utils unzip",
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )

        # Packed from this working copy rather than fetched from a tag, so a
        # run measures the code in front of us. `scripts/install.sh` is the
        # route a user takes; both end at `npm install -g <tarball>`, which is
        # the only form that copies rather than symlinking a directory.
        tarball = self._pack()
        remote_tarball = "/tmp/paper-orchestra.tgz"
        await environment.upload_file(str(tarball), remote_tarball)

        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"{nvm_node_install_snippet()} && "
                f"npm install -g {shlex.quote(remote_tarball)} opencode-ai"
                # Only when the job authorized paid retrieval. PaperOrchestra
                # shells out to `bohr` by name, so the paid path needs the CLI
                # present -- and a job that will never take that path should not
                # wait for a dependency it cannot use.
                + (" @dptech-corp/bohr-cli" if self.allow_lkm_spend else "")
                + " && paper-orchestra --version && opencode --version"
                + (" && bohr --version" if self.allow_lkm_spend else "")
            ),
        )

    def _pack(self) -> Path:
        """`npm pack` this working copy and return the tarball path."""
        out = Path(tempfile.mkdtemp(prefix="po-pack-"))
        subprocess.run(["npm", "run", "build"], cwd=REPO_ROOT, check=True,
                       stdout=subprocess.DEVNULL)
        name = subprocess.run(
            ["npm", "pack", str(REPO_ROOT)], cwd=out, check=True,
            capture_output=True, text=True,
        ).stdout.strip().splitlines()[-1]
        return out / name

    # -- run ----------------------------------------------------------------

    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        env = await self._provision_credentials(environment)

        model_flag = f"--model {shlex.quote(self.model_name)} " if self.model_name else ""

        # Retrieval flags, only when the job asked for them. `--allow-lkm-spend`
        # is what turns the literature stage's paid substep on; a task supplying
        # its own bibliography ignores it, because that path costs nothing and
        # runs whether or not spending was authorized.
        retrieval_flags = ""
        if self.allow_lkm_spend:
            retrieval_flags += "--allow-lkm-spend "
        if self.max_lkm_calls is not None:
            retrieval_flags += f"--max-lkm-calls {self.max_lkm_calls} "
        if self.target_citations is not None:
            retrieval_flags += f"--target-citations {self.target_citations} "
        if self.research_cutoff:
            retrieval_flags += f"--research-cutoff {shlex.quote(self.research_cutoff)} "

        # The rendered instruction IS the brief: Harbor's contract is one
        # location plus one instruction, and the instruction is where the venue,
        # the page limit and the per-section requirements live. It is written to
        # the log directory and handed over with `--brief`, so PaperOrchestra
        # locks it into the workspace itself.
        #
        # Note what this is not: the adapter does not put it among the
        # materials, name a template, or write a guidelines file. `--brief` is a
        # parameter the tool has, so passing it is mechanical -- which is the
        # only kind of work that belongs here.
        instruction_path = "/logs/agent/instruction.md"
        await self.exec_as_agent(
            environment,
            command=(
                f"mkdir -p /logs/agent && cat > {instruction_path} <<'PO_EOF'\n"
                f"{instruction}\nPO_EOF"
            ),
        )

        await self.exec_as_agent(
            environment,
            command=(
                ". ~/.nvm/nvm.sh 2>/dev/null; "
                f"paper-orchestra write /workspace {model_flag}{retrieval_flags}"
                f"--brief {shlex.quote(instruction_path)} "
                f"--headless --json -o {shlex.quote(WORKSPACE)} "
                "2>&1 | stdbuf -oL tee /logs/agent/paper-orchestra.jsonl"
            ),
            env=env,
        )

        await self._map_submission(environment)

    async def _provision_credentials(self, environment: BaseEnvironment) -> dict[str, str]:
        """Give the container whatever this host uses to reach a model."""
        env: dict[str, str] = {}
        for key in (
            "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENCODE_API_KEY",
            "ANTHROPIC_API_KEY", "BOHRIUM_PROJECT_ID",
        ):
            value = self._get_env(key)
            if value:
                env[key] = value

        # Fail here rather than at the literature stage. Without this, a job
        # that authorized spending would install, prepare, triage and outline --
        # four stages and most of the tokens -- before discovering it has no
        # credential, and the error would arrive half an hour in.
        if self.allow_lkm_spend:
            access_key = _host_bohr_access_key()
            if not access_key:
                raise RuntimeError(
                    "allow_lkm_spend was requested but this host has no Bohrium access key. "
                    f"Set ${BOHR_ACCESS_KEY_ENV}, or run `bohr auth login` so the key lands in "
                    f"{BOHR_CLI_CONFIG}."
                )
            # The key alone, in the environment. `bohr` authenticates from
            # $BOHR_ACCESS_KEY with no home directory and no login, so the OAuth
            # token file beside it never has to travel.
            env[BOHR_ACCESS_KEY_ENV] = access_key
            self.logger.debug("PaperOrchestra: forwarding %s", BOHR_ACCESS_KEY_ENV)

        # An OAuth login has no API key to forward, so the credential file
        # itself has to travel. Same approach as the Codex adapter.
        auth = _host_auth_json()
        if auth is not None:
            self.logger.debug("PaperOrchestra: uploading OpenCode auth.json")
            await self.exec_as_agent(
                environment, command=f"mkdir -p {shlex.quote(str(Path(REMOTE_AUTH).parent))}"
            )
            await environment.upload_file(str(auth), REMOTE_AUTH)
            # upload_file lands root-owned; hand it to whoever runs the agent.
            if environment.default_user is not None:
                await self.exec_as_root(
                    environment, command=f"chown {environment.default_user} {REMOTE_AUTH}"
                )
        return env

    async def _map_submission(self, environment: BaseEnvironment) -> None:
        """
        Lay the workspace out the way the task's contract asks for.

        Purely mechanical, and purely the adapter's business: PaperOrchestra's
        layout is its own, every benchmark asks for something different, and a
        product that reshaped itself per grader would be following the grader.

        The manuscript must compile from the submission directory alone, so the
        template's support files travel with it -- the same closure
        `stageBuildDir` assembles for PaperOrchestra's own builds.
        """
        script = rf"""
set -eu
WS={shlex.quote(WORKSPACE)}
SUB=/workspace/submission
mkdir -p "$SUB"

# The template's contributions go FIRST, so that anything the run also
# produces overwrites them rather than the other way round. Order is
# load-bearing: a venue author kit ships its own placeholder references.bib,
# and when the template occupies a directory of its own the attribution step
# correctly claims that stub as part of the template. Copied last, it landed on
# top of the bibliography the run had just retrieved -- the manuscript then
# cited 51 real sources against a stub defining none, and the grader's
# "every cited key exists in references.bib" test failed on 20 keys while
# PaperOrchestra's own checks all passed, because inside the workspace the
# bibliography was correct.
if [ -d "$WS/template" ]; then
  ( cd "$WS/template" && find . -type f ! -name 'template.tex' -print0 \
    | while IFS= read -r -d '' f; do
        mkdir -p "$SUB/$(dirname "$f")"
        cp "$f" "$SUB/$f"
      done )
fi

if [ -f "$WS/.brain/manuscript/final_paper.tex" ]; then
  cp "$WS/.brain/manuscript/final_paper.tex" "$SUB/main.tex"
elif [ -f "$WS/.brain/manuscript/raw_draft.tex" ]; then
  echo "PO_SUBMIT: no final_paper.tex; falling back to raw_draft.tex" >&2
  cp "$WS/.brain/manuscript/raw_draft.tex" "$SUB/main.tex"
else
  echo "PO_SUBMIT: the run produced no manuscript" >&2
fi

# After the template sweep, and unconditionally: this is the bibliography the
# manuscript was written against.
if [ -f "$WS/.brain/raw/references.bib" ]; then
  cp "$WS/.brain/raw/references.bib" "$SUB/references.bib"
else
  echo "PO_SUBMIT: the run produced no references.bib" >&2
fi

if [ -d "$WS/.brain/manuscript/figures" ]; then
  mkdir -p "$SUB/figures"
  find "$WS/.brain/manuscript/figures" -maxdepth 1 -type f ! -name 'info.json' \
    -exec cp {{}} "$SUB/figures/" \;
fi

chmod -R u+w "$SUB"
ls -la "$SUB"
"""
        await self.exec_as_agent(environment, command=script)

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        """Surface the run's own record so a reader need not open the trial."""
        report = Path(self.logs_dir) / "paper-orchestra.jsonl"
        if not report.is_file():
            return
        for line in reversed(report.read_text(errors="replace").splitlines()):
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if event.get("type") == "result":
                context.metadata = {**(context.metadata or {}), "paper_orchestra": event}
                return
