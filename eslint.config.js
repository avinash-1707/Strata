// @ts-check
import tseslint from "typescript-eslint";

/**
 * One complete `no-restricted-imports` block for a directory.
 *
 * `forbidden` names sibling directories under src/. `**\/tests/**` is added to every
 * block because tests/ is not in the build, so importing a fake from production code
 * fails at runtime rather than at compile time.
 */
function seam(directory, forbidden, ignores) {
  return [
    {
      files: [`${directory}/**/*.ts`],
      ...(ignores === undefined ? {} : { ignores }),
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                group: [...forbidden.map((name) => `**/${name}/**`), "**/tests/**"],
                message:
                  `${directory} may not import: ${forbidden.join(", ")}, or a test fake. ` +
                  "See docs/coding-standards.md §4 and DD-032.",
              },
            ],
          },
        ],
      },
    },
  ];
}

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**"] },

  ...tseslint.configs.strictTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // `*.config.ts` is in tsconfig's `include`, so only the untyped JS config
          // needs the escape hatch.
          allowDefaultProject: ["*.config.js"],
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
     than remembered. Each is a boundary whose violation is invisible in review: the
     code compiles and the tests pass; only the architecture rots.
     
     Flat config *replaces* a rule for overlapping `files` rather than merging, so
     every block below lists its forbidden imports in full. An earlier version relied
     on a shared block plus per-directory additions, and the additions silently
     discarded the shared one — caught only by planting a violation in each
     directory. Do not refactor this into a base-plus-override. */
  ...seam("src", ["db", "store/pg", "mcp", "http"], ["src/main.ts"]),
  ...seam("src/search", ["db", "cache", "ollama", "store", "mcp", "http"]),
  ...seam("src/db", ["cache", "ollama", "store", "search", "mcp", "http"]),
  ...seam("src/cache", ["db", "ollama", "store", "search", "mcp", "http"]),
  ...seam("src/ollama", ["db", "cache", "store", "search", "mcp", "http"]),
  /* The store receives a query vector, never an embedder: letting it reach for Ollama
     so searchSemantic could embed its own query is how the isolation collapses. */
  ...seam("src/store", ["db", "cache", "ollama", "mcp", "http"], ["src/store/pg/**"]),
  /* The one directory allowed to hold SQL and to touch the pool. */
  ...seam("src/store/pg", ["cache", "ollama", "mcp", "http"]),
  /* Domain tools must be reachable from any surface, so they may depend on none. */
  ...seam("src/tools", ["db", "store/pg", "mcp", "http"]),
  /* Surfaces call tools and receive a MemoryStore through ToolDeps. */
  ...seam("src/mcp", ["db", "store/pg", "http"]),
  ...seam("src/http", ["db", "store/pg", "mcp"]),

  {
    /* The composition root: the one production file allowed to name every layer,
       because assembling them is its job (architecture § Module map). It still may
       not import a test fake. */
    files: ["src/main.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/tests/**"],
              message: "src/main.ts may not import a test fake. See DD-032.",
            },
          ],
        },
      ],
    },
  },

  {
    /* Tests and fakes may assert on values the type system can't prove, may use
       non-null assertions on fixture data that is obviously present, and are exempt
       from the seam rules above — a test legitimately reaches across every layer. */
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "no-restricted-imports": "off",
    },
  },

  {
    files: ["eslint.config.js"],
    ...tseslint.configs.disableTypeChecked,
  },
);
