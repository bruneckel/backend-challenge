import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const numberGuardMessage =
  'Money must stay a decimal string or a Money instance; never convert it to a JavaScript number.';

export default defineConfig(
  { ignores: ['node_modules', 'coverage', 'dist', '.superpowers'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../*', '../**'],
              message: 'Use a path alias such as @wallet/... or @shared/... instead of a parent-relative import.',
            },
          ],
        },
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
