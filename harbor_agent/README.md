# Harbor agent adapter

Runs PaperOrchestra as a Harbor agent, so the benchmark drives it the way it
drives every other agent.

```bash
PYTHONPATH=$(git rev-parse --show-toplevel) harbor run \
  --agent harbor_agent.paper_orchestra:PaperOrchestra \
  --model openai/gpt-5.6-sol \
  -p paperwrite-bench-short/pwb-0001 \
  --agent-timeout-multiplier 2.5
```

`--agent-timeout-multiplier` is needed because these tasks give an agent one
hour and PaperOrchestra's stage budgets sum to 145 minutes. That mismatch is
worth knowing rather than hiding: a pipeline that validates and remediates each
stage is slower than a single agent loop, and the tasks were written for the
latter.

## What the adapter does, and what it refuses to do

Install, credentials, invoke, and map the finished workspace onto the task's
submission contract. All mechanical.

It does **not** prepare the input. No pointing at a template, no naming a
document, no writing a guidelines file. If it ever appears to need to, that is
a capability missing from PaperOrchestra and it belongs there -- the whole
reason to run under Harbor is that the container gives the agent `/workspace`
and nobody the chance to tidy it first. Preparing workspaces by hand is how a
9-page limit got invented for a task whose brief says 11.

## Credentials

Forwards `OPENAI_API_KEY`, `OPENCODE_API_KEY`, `ANTHROPIC_API_KEY`,
`BOHRIUM_ACCESS_KEY` and `BOHRIUM_PROJECT_ID` when the host has them, and
uploads `~/.local/share/opencode/auth.json` when it exists -- an OAuth login
has no key to forward, so the credential file itself has to travel. Same
approach as Harbor's own Codex adapter.

Without Bohrium credentials the literature stage cannot retrieve, so start with
tasks that supply a `references.bib` (`paperwrite-bench-short`,
`lifesci-paperrecon-short`): those take the zero-spend path and exercise
template discovery and the supplied-bibliography path at once.

## Installation

`npm pack` of the working copy, uploaded and installed with
`npm install -g <tarball>`. Packing matters: npm symlinks a local *directory*,
so installing one leaves the container pointing at a path that is not there.
`scripts/install.sh` takes the same route for the same reason.

Packing from the working copy rather than a tag is deliberate -- a run should
measure the code in front of us.

## The instruction

Harbor renders the task's `instruction.md` and hands it to `run()`. It is saved
to `/logs/agent/instruction.md` and **not** given to PaperOrchestra, which has
no parameter for a writing brief yet.

That is a real gap and the log is where to see it: the brief carries the page
limit and the section-by-section requirements. Feeding it in by writing a file
into the materials would make the adapter prepare the input, so the honest move
is to leave it out and let the benchmark's rubric show what the absence costs.
