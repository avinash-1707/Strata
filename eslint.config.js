// @ts-check
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**"] },

  ...tseslint.configs.strictTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Root-level config files aren't in tsconfig's `include` (which is
          // src-only, to keep the build output clean) but still need linting.
          allowDefaultProject: ["*.config.ts", "*.config.js"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Allow the `_`-prefixed throwaway in destructuring-to-omit.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],

      /* stdout is the MCP protocol channel. A stray console write corrupts the
         JSON-RPC stream and presents as a client-side bug (DD-026). This rule,
         not vigilance, is what keeps that from happening. */
      "no-console": "error",

      /* docs/coding-standards.md §2 — no `any` at module boundaries. */
      "@typescript-eslint/no-explicit-any": "error",

      /* §7 — no floating promises, no accidentally-sequential awaits. */
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",

      /* §6 — never swallow an error. An empty block is the classic way to. */
      "no-empty": ["error", { allowEmptyCatch: false }],

      /* §10 — prefer immutability at boundaries. */
      "@typescript-eslint/prefer-readonly": "error",

      /* Encourage `import type` so verbatimModuleSyntax stays clean. */
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
    },
  },

  /* The module seams from docs/coding-standards.md §4 and DD-032, enforced rather
     than remembered. Each of these is a boundary whose violation is invisible in
     review — the code compiles and the tests pass; only the architecture rots. */

  /* Inbound, not outbound: the rules below say what each directory may import,
     which leaves the central DD-032 boundary — who may reach the pg pool —
     unguarded. src/db is importable only from the Postgres store. */
  {
    files: ["src/**/*.ts"],
    ignores: ["src/db/**", "src/store/pg/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/db/**"],
              message:
                "Only src/store/pg/** may import the pg pool. Everything above the store receives a MemoryStore (DD-032).",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/db/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/cache/**", "**/ollama/**", "**/store/**", "**/mcp/**", "**/search/**"],
              message:
                "src/db must import only pg and config. Any one of db/cache/ollama has to be replaceable without touching the other two — composition belongs in src/mcp/tools.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/cache/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/db/**", "**/ollama/**", "**/store/**", "**/mcp/**", "**/search/**"],
              message:
                "src/cache must import only redis and config. See docs/coding-standards.md §4.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/ollama/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/db/**", "**/cache/**", "**/store/**", "**/mcp/**", "**/search/**"],
              message:
                "src/ollama must import only fetch and config. See docs/coding-standards.md §4.",
            },
          ],
        },
      ],
    },
  },
  {
    /* The store receives a query vector, never an embedder: letting it reach for
       Ollama so semanticSearch could embed its own query is exactly how the
       db/cache/ollama isolation collapses (DD-032). */
    files: ["src/store/**/*.ts"],
    ignores: ["src/store/pg/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/db/**", "**/cache/**", "**/ollama/**", "**/mcp/**"],
              message:
                "src/store owns SQL over memories and nothing else. Only src/store/pg may touch the pg pool, and no part of the store may reach for the cache, a model, or a tool.",
            },
          ],
        },
      ],
    },
  },
  {
    /* The one directory permitted to hold SQL and the one permitted to import the
       pool. Everything else about the store's isolation still applies. */
    files: ["src/store/pg/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/cache/**", "**/ollama/**", "**/mcp/**"],
              message:
                "src/store/pg owns SQL over memories and nothing else. It must not reach for the cache, a model, or a tool.",
            },
          ],
        },
      ],
    },
  },
  {
    /* Tools compose domain operations; SQL and the raw pool stay below them
       (DD-032). A tool holding SQL is the defect this rule exists to catch. */
    files: ["src/mcp/**/*.ts"],
    ignores: ["src/mcp/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/db/**", "**/store/pg/**", "**/testing/**"],
              message:
                "Tools receive a MemoryStore through ToolDeps. They must not import the pg pool, the Postgres store implementation, or a fake.",
            },
          ],
        },
      ],
    },
  },

  {
    /* Tests may assert on values the type system can't prove, and may use
       non-null assertions on fixture data that is obviously present. */
    files: ["src/**/*.test.ts", "src/testing/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
    },
  },

  {
    files: ["eslint.config.js"],
    ...tseslint.configs.disableTypeChecked,
  },
);
