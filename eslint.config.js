import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // The backend has its own typecheck; the React Workspace shell under
  // backend/workspace-ui is front-end code and lints with the site.
  globalIgnores(['backend/*', '!backend/workspace-ui/', '**/dist/**', '**/coverage/**']),
  {
    // The agentbuilt CLI is one plain .mjs file, and until now no config
    // matched it — so `no-undef` never ran on the one file we ship whole to
    // every agent machine. v67 deleted a helper `note list` still called, and
    // the ReferenceError was found by an agent, in production. It lints clean
    // today; keep it that way.
    //
    // Note this is a second net, not the gate: CI runs lint advisorily
    // (`npm run lint || echo …`). The hard gate is
    // backend/src/test/unit/agentbuilt-note-cli.test.ts, which runs the CLI.
    files: ['cli/**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
])
