# Execution container for `execute` jobs (plan §4 Phase 6).
#
# STATUS: STUB. The current execute runner runs the Claude Agent SDK in-process against the
# session worktree (USE_CONTAINER is honored as a flag but not yet wired to `docker run`).
# This image is the target for isolated, egress-allowlisted execution under OrbStack.
#
# TODO(Phase 6 hardening):
#   - Base image with git + Bun (or Node) + the Claude Agent SDK preinstalled.
#   - Mount the session worktree read-write at /work; run as a non-root user.
#   - Inject subscription auth (mount ~/.claude/.credentials.json read-only, or pass
#     CLAUDE_CODE_OAUTH_TOKEN) — never an ANTHROPIC_API_KEY (see open-questions §E).
#   - Constrain egress to an allowlist (Anthropic API, GitHub, package registries) at the
#     OrbStack/network layer.
#   - Entrypoint runs a small driver that invokes the SDK with permissionMode "dontAsk" +
#     allowedTools and streams results back to the host (or writes a result file the host reads).

FROM oven/bun:1-debian

# TODO: install git and any toolchains the target repos need to run tests.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# TODO: create a non-root user and a /work mountpoint.
WORKDIR /work

# TODO: COPY a container-side driver script and set it as the ENTRYPOINT. Until then this image
# is a placeholder and the host runs the SDK in-process.
CMD ["bun", "--version"]
