# AGENTS

Complete the task. After every task, **explicitly verify** using this repository's testing frameworks on Node 24:

- Vitest: `pnpm test`
- Playwright: `pnpm test:e2e`
- Linting: `pnpm lint` and `pnpm lint:apply`
- Criterion (when necessary): `pnpm bench`

If the test fails, gauge to fix the test or fix the implementation while preventing regressions.

## Testing

- Put end-to-end tests in e2e.
- Use Playwright locators by role/text/test id instead of brittle CSS selectors.
- Prefer user-visible behavior tests over implementation tests.
- Do not update snapshots blindly.
- For UI-affecting changes, add or update a Playwright test when practical.

If the test fails, gauge to fix the test or fix the implementation while preventing regressions.

## Safety

- Do not rewrite unrelated files.
- Do not perform large refactors unless asked.
- Keep changes minimal, focused, and reversible.
- If a command fails, explain the failure and the smallest next fix.

## Style

- Use TypeScript for new code.
- Prefer named exports for shared utilities/components.
- Keep React components small and composable.
- Avoid any; use unknown, discriminated unions, or explicit types.
- Keep side effects out of render paths.
- Put reusable UI in src/components.
- Put domain logic in src/lib or src/features.
- Do not introduce ESLint or Prettier; Biome is the formatter/linter.

## Code exploration — prefer `ast-outline`/`ast-bro` over full reads
