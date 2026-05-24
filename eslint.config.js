import js from "@eslint/js"
import {jsdoc} from "eslint-plugin-jsdoc"
import globals from "globals"
import {defineConfig} from "eslint/config"

export default defineConfig([
  {
    name: "global ignores",
    ignores: ["build/**", "tmp/**"]
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    plugins: {js},
    extends: ["js/recommended"],
    languageOptions: {
      globals: {...globals.browser, ...globals.node}
    },
    rules: {
      "no-unused-vars": ["error", {argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_"}]
    }
  },
  jsdoc({
    config: "flat/recommended",
    files: ["src/**/*.js"],
    rules: {
      "jsdoc/reject-any-type": "off",
      "jsdoc/no-undefined-types": ["warn", {definedTypes: ["Iterable", "IterableIterator", "AsyncIterable"]}]
    }
  }),
  {
    files: ["spec/**/*.js"],
    rules: {
      "no-undef": "off"
    }
  }
])
