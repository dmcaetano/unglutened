<!-- BEGIN GENERATED: resources -- do not edit inside this block -->

# UnGlutened — agent brief

*Generated from `resources.yaml` by `_tools/resources/gen_resources.py` on 2026-09-07.*
*Edit `resources.yaml`'s `declared:` block, then re-run the generator — do not edit inside this block.*

## Before you change anything: is this the live copy?

This repo can be checked out more than once on disk. **Three numbers must agree** —
the remote tip, this checkout's HEAD, and what production is actually running:

```bash
git -C . fetch origin && git -C . rev-list --left-right --count HEAD...@{upstream}
```

| | |
|---|---|
| remote | `https://github.com/dmcaetano/unglutened.git` |
| branch | `main` |
| status at generation | **1 unpushed commit** |

## What this is

- **Purpose** (quoted from this project's own `DESCRIPTION.md`, not independently verified)**:** A personal, mobile-first Progressive Web App that tracks food and gut health, extracts ingredients from meal photos via AI vision, and surfaces correlations between what you ate and how you felt.
- **For:** _not yet declared_
- **SDLC class:** `SOLO`
- **Version:** 1.1.11 "Batman" (from `version.json`)
- **Stack:** node
- **Deploys via:** render
- **URL (claimed in STATE.md, not verified):** https://unglutened.onrender.com

### What the SDLC class means here

**SOLO** — only Diogo and Claude. Write `intent.md` then `spec.md`, have a *separate*
reviewer agent sign them (never self-approve), then commit, push, merge and deploy
without waiting on Diogo. Only an ESCALATE verdict reaches him.

Either way, these stay gated on Diogo regardless of class: deleting data, sending email,
publishing to third parties, spending money. Full chain: `~/.claude/skills/sdlc/SKILL.md`.

## What it may use

_No capabilities declared yet._ If this project needs email, Drive, Slack, GitHub or
similar, list the keys in `resources.yaml` → `declared.capabilities_required`.

**Read `_tools/resources/capabilities.yaml` before using any integration** — it records how
each one is reached on the PC versus the phone, which hooks guard it, and which facts are
still disputed. Do not assume a capability works the way it does on another machine.

## Credentials

_None declared._

Credentials are referenced **by location, never by value**. Never paste a secret into this
file, into `resources.yaml`, or into a commit.

## Non-negotiable

- Anything that runs locally calls the model through the Claude Code CLI (`claude -p`) on
  Diogo's **Anthropic subscription** — never an API key or metered provider, and no fallback to
  one. Code hosted off his machines: ask Diogo before wiring any provider. How it is done: the
  "LOCAL = ANTHROPIC SUBSCRIPTION" rule in `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`;
  reference implementation `FRIDAY/app/llm.py`.
- Done means deployed and verified by observed execution. A green build or an HTTP 200 is
  not proof.
- Every commit bumps a version counter and is announced with the exact version string.

<!-- END GENERATED: resources -->
