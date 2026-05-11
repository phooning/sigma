# AGENTS

Complete the task. After every task, **explicitly verify** using this repository's testing frameworks on Node 24:

- Vitest: `pnpm test`
- Playwright: `pnpm test:e2e`
- Linting: `pnpm lint` and `pnpm lint:apply`
- Criterion (when necessary): `pnpm bench`

If the test fails, gauge to fix the test or fix the implementation while preventing regressions.

## Testing

* Put end-to-end tests in e2e.
* Use Playwright locators by role/text/test id instead of brittle CSS selectors.
* Prefer user-visible behavior tests over implementation tests.
* Do not update snapshots blindly.
* For UI-affecting changes, add or update a Playwright test when practical.

If the test fails, gauge to fix the test or fix the implementation while preventing regressions.

## Safety

* Do not rewrite unrelated files.
* Do not perform large refactors unless asked.
* Keep changes minimal, focused, and reversible.
* If a command fails, explain the failure and the smallest next fix.

## Style

* Use TypeScript for new code.
* Prefer named exports for shared utilities/components.
* Keep React components small and composable.
* Avoid any; use unknown, discriminated unions, or explicit types.
* Keep side effects out of render paths.
* Put reusable UI in src/components.
* Put domain logic in src/lib or src/features.
* Do not introduce ESLint or Prettier; Biome is the formatter/linter.

## Code exploration — prefer `ast-outline` over full reads

For `.rs`, `.cs`, `.py`, `.pyi`, `.ts`, `.tsx`, `.js`, `.jsx`, `.java`, `.kt`, `.kts`,
`.scala`, `.sc`, `.go`, and `.md` files, read structure with `ast-outline`
before opening full contents.
Pull method bodies only once you know which ones you need.

Stop at the step that answers the question:

1. **Unfamiliar directory** — `ast-outline digest <dir>`: one-page map
   of every file's types and public methods.

2. **One file's shape** — `ast-outline <file>`: signatures with line
   ranges, no bodies (5–10× smaller than a full read).

3. **One method, class, or markdown section** — `ast-outline show <file>
   <Symbol>`. Suffix matching: `TakeDamage`, or `Player.TakeDamage` when
   ambiguous. Multiple at once: `ast-outline show Player.cs TakeDamage
   Heal Die`. For markdown, the symbol is the heading text.

4. **Who implements/extends a type** — `ast-outline implements <Type>
   <dir>`: AST-accurate (skip `grep`), transitive by default with
   `[via Parent]` tags on indirect matches. Add `--direct` for level-1 only.

Fall back to a full read only when you need context beyond the body
`show` returned.

If the outline header contains `# WARNING: N parse errors`, the outline
for that file is partial — read the source directly for the affected region.

`ast-outline help` for flags and rare options.
