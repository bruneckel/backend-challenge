import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const numberGuardMessage =
  'Money must stay a decimal string or a Money instance; never convert it to a JavaScript number.';

const parentRelativeImports = {
  group: ['../*', '../**'],
  message: 'Use a path alias such as @wallet/... or @shared/... instead of a parent-relative import.',
};

const layerBoundaryImports = [
  {
    group: ['@aws-sdk/*', '@mikro-orm/*', '@nestjs/*', 'pg', 'kysely'],
    message: 'Domain and application code cannot depend on frameworks, drivers or the SQS client; depend on a port.',
  },
  {
    group: ['@platform/*', '@*/infrastructure/**'],
    message: 'Domain and application code cannot import infrastructure; depend on a port.',
  },
];

const domainBoundaryImports = {
  group: ['@*/application/**'],
  message: 'Domain code cannot depend on the application layer.',
};

export default defineConfig(
  { ignores: ['node_modules', 'coverage', 'dist', '.superpowers'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [parentRelativeImports] }],
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['src/**/application/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [parentRelativeImports, ...layerBoundaryImports] }],
    },
  },
  {
    files: ['src/**/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [parentRelativeImports, ...layerBoundaryImports, domainBoundaryImports] },
      ],
    },
  },
  {
    files: ['src/**/domain/**/*.ts', 'src/**/application/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'parseFloat', message: numberGuardMessage },
        { name: 'parseInt', message: numberGuardMessage },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Number', property: 'parseFloat', message: numberGuardMessage },
        { object: 'Number', property: 'parseInt', message: numberGuardMessage },
        { property: 'toNumber', message: numberGuardMessage },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "CallExpression[callee.name='Number']", message: numberGuardMessage },
      ],
    },
  },
);
