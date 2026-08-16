# CodeSmith contributor instructions

- Use TypeScript with Node.js 22 or later. Keep the codebase strict and avoid
  unsafe type assertions.
- Keep production code under `src/` and place tests in the matching domain under
  `tests/`.
- Preserve layer boundaries: `src/core/` is the public UI-neutral API, `src/cli/`
  owns terminal interaction, and `src/workspace/` owns sandboxing and command
  policy.
- Treat workspace containment, command allowlists, approval flows, and credential
  redaction as security-sensitive. Do not broaden access or bypass approvals
  without an explicit requirement and matching tests.
- Prefer the existing `ModelProvider` and model catalog abstractions for provider
  work rather than adding provider-specific behavior to the agent loop.
- When behavior changes, add or update focused tests. Run `npm test`,
  `npm run build`, and `npm run lint` before submitting changes.
- Use Prettier formatting. Run `npm run format` for formatting changes, and keep
  `package-lock.json` in sync when dependencies change.
