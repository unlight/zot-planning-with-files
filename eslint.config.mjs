import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-plugin-prettier/recommended';
import unicorn from 'eslint-plugin-unicorn';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['coverage/**', 'dist/**', 'node_modules/**'] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  unicorn.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      globals: globals.node,
      parserOptions: {
        projectService: true,
      },
      sourceType: 'module',
    },
    rules: {
      'max-lines': ['warn', { max: 400 }],
      'max-params': ['warn', { max: 3 }],
      // Short JSDoc stays on one line; asterisk prefixes are allowed.
      'unicorn/no-asterisk-prefix-in-documentation-comments': 'off',
      'unicorn/single-line-block-comment-style': 'off',
    },
  },
  {
    extends: [tseslint.configs.disableTypeChecked],
    files: ['*.config.mjs'],
  },
  {
    files: ['**/*.test.ts'],
    rules: {
      'max-lines': 'off',
      // Test helpers read better with names like `predicate` and `projectDir`.
      'unicorn/consistent-boolean-name': 'off',
      'unicorn/import-style': 'off',
      'unicorn/name-replacements': 'off',
    },
  },
);
