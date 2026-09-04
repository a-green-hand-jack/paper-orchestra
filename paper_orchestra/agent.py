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


class PaperOrchestra(BaseInstalledAgent):
    """Run the PaperOrchestra writing pipeline inside a Harbor task."""

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
                f"npm install -g {shlex.quote(remote_tarball)} opencode-ai && "
                "paper-orchestra --version && opencode --version"
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
                f"paper-orchestra write /workspace {model_flag}"
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
            "ANTHROPIC_API_KEY", "BOHRIUM_ACCESS_KEY", "BOHRIUM_PROJECT_ID",
        ):
            value = self._get_env(key)
            if value:
                env[key] = value

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

if [ -f "$WS/.brain/manuscript/final_paper.tex" ]; then
  cp "$WS/.brain/manuscript/final_paper.tex" "$SUB/main.tex"
elif [ -f "$WS/.brain/manuscript/raw_draft.tex" ]; then
  echo "PO_SUBMIT: no final_paper.tex; falling back to raw_draft.tex" >&2
  cp "$WS/.brain/manuscript/raw_draft.tex" "$SUB/main.tex"
else
  echo "PO_SUBMIT: the run produced no manuscript" >&2
fi

[ -f "$WS/.brain/raw/references.bib" ] && cp "$WS/.brain/raw/references.bib" "$SUB/references.bib"

if [ -d "$WS/.brain/manuscript/figures" ]; then
  mkdir -p "$SUB/figures"
  find "$WS/.brain/manuscript/figures" -maxdepth 1 -type f ! -name 'info.json' \
    -exec cp {{}} "$SUB/figures/" \;
fi

# Everything the template contributes except its own placeholder main file.
if [ -d "$WS/template" ]; then
  ( cd "$WS/template" && find . -type f ! -name 'template.tex' -print0 \
    | while IFS= read -r -d '' f; do
        mkdir -p "$SUB/$(dirname "$f")"
        cp "$f" "$SUB/$f"
      done )
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
