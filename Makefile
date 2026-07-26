# Skynet dev convenience — tracked at the repo root so every worktree has it.
#
#   make dev   →  copy .env if missing, install deps, launch the desktop app
#   make env   →  just copy .env from the main working tree if this one lacks it
#
# `pnpm install` runs first on purpose: `desktop:dev` rebuilds the workspace
# packages on boot but does NOT install, so a `git pull` that adds a new
# dependency otherwise fails at startup. Installing first makes that a non-issue.
#
# The skynet/ path is resolved relative to THIS Makefile, so `make dev` in any
# worktree runs THAT worktree's skynet/ — not the primary checkout.

ROOT := $(dir $(realpath $(lastword $(MAKEFILE_LIST))))
SKYNET := $(ROOT)skynet
# The main working tree (first entry of `git worktree list`) is the source of
# truth for .env — it's gitignored (holds ANTHROPIC_API_KEY etc.), so it's never
# checked in and a fresh worktree has none. Found dynamically: no hardcoded path.
MAIN := $(shell git -C "$(ROOT)" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $$2; exit}')

.PHONY: dev env

# Copy the main tree's .env into this worktree if it's MISSING, so worktree runs
# have the provider keys. Never overwrites an existing one; no-op in the main
# tree (source == destination).
env:
	@if [ ! -f "$(SKYNET)/.env" ] && [ -f "$(MAIN)/skynet/.env" ] && [ "$(MAIN)/skynet/.env" != "$(SKYNET)/.env" ]; then \
		cp "$(MAIN)/skynet/.env" "$(SKYNET)/.env" && echo "[make] copied .env from main working tree: $(MAIN)/skynet/.env"; \
	fi

dev: env
	cd "$(SKYNET)" && pnpm install && pnpm desktop:dev
