import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'prisma/migrations/**', 'postman/**', 'docs/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
      // Ambient declaration namespaces (Express augmentation, DTO contracts) are allowed.
      '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }],
      'no-console': 'warn',
      eqeqeq: ['error', 'always'],
      'no-restricted-syntax': [
        'error',
        {
          selector: "BinaryExpression[operator='+'] > MemberExpression[object.name='Math'][property.name='random']",
          message: 'Math.random is not permitted for security-sensitive values. Use crypto.',
        },
      ],
    },
  },
  {
    files: ['tests/**/*.ts', 'scripts/**/*.ts', 'prisma/**/*.ts', 'src/**/*.test.ts'],
    rules: {
      'no-console': 'off',
    },
  },
);
