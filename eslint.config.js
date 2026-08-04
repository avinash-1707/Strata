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
