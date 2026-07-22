# Skynet dev convenience — tracked at the repo root so every worktree has it.
#
#   make dev   →  install deps, then launch the desktop app (hot reload)
#
# `pnpm install` runs first on purpose: `desktop:dev` rebuilds the workspace
# packages on boot but does NOT install, so a `git pull` that adds a new
# dependency otherwise fails at startup. Installing first makes that a non-issue.
#
# The skynet/ path is resolved relative to THIS Makefile, so `make dev` in any
# worktree runs THAT worktree's skynet/ — not the primary checkout.

ROOT := $(dir $(realpath $(lastword $(MAKEFILE_LIST))))
SKYNET := $(ROOT)skynet

.PHONY: dev
dev:
	cd "$(SKYNET)" && pnpm install && pnpm desktop:dev
