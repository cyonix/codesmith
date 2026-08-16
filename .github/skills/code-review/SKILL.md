---
name: code-review
description: Review CodeSmith changes for high-confidence correctness, security, and regression issues. Use when asked to review a diff, pull request, branch, staged changes, or implementation.
---

# Code Review

Review only the requested change set. Report high-confidence bugs, security
vulnerabilities, regressions, and missing behavior; do not report style
preferences, speculative concerns, or pre-existing issues outside the changed
code.

## Establish scope

1. Read this repository's contributor instructions and any instructions that
   apply to the changed paths.
2. Identify the review target: staged changes, unstaged changes, a branch diff,
   or a pull request diff.
3. For branch or pull request reviews, inspect the merge base, changed files,
   and full diffs before drawing conclusions. For staged or unstaged reviews,
   inspect the applicable working-tree diff instead. Read enough unchanged
   context to understand control flow and call sites.
4. Treat a changed line as the anchor for each finding. Do not comment on an
   unchanged line unless the reviewed change directly makes it defective.

## Review priorities

Review in this order:

1. Correctness: invalid assumptions, broken control flow, incorrect state
   changes, error handling, data loss, and compatibility regressions.
2. Security: workspace containment, command allowlists, approval flows,
   credential redaction, filesystem access, path traversal, and unintended
   network or command execution.
3. Architecture: preserve `src/core/` as the UI-neutral public API,
   `src/cli/` for terminal interaction, and `src/workspace/` for sandboxing and
   command policy. Do not allow provider-specific behavior to leak into the
   agent loop when the model provider or catalog abstractions apply.
4. Tests: verify that changed behavior is covered by focused tests in the
   matching `tests/` domain, especially error paths and security-sensitive
   behavior.

## Findings

Only report findings that a maintainer should act on. Each finding must include:

- Severity: `blocking`, `warning`, or `info`.
- A concise title.
- File and changed-line reference.
- The concrete failure scenario and impact.
- A direct, minimal recommendation.

Order findings by severity. If there are no actionable findings, state that
clearly and mention any meaningful residual risk or test gap only when it
relates directly to the reviewed changes.

Do not modify production code during a review unless explicitly asked to fix
the findings. Do not approve changes that broaden security-sensitive access or
bypass approvals without an explicit requirement and matching tests.
