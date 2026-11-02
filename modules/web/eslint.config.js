import vue from 'eslint-plugin-vue';

// Oxlint owns script rules. ESLint only checks Vue templates.
export default [
  { ignores: ['node_modules/**'] },
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vue.configs['flat/base'][1].languageOptions.parser,
      parserOptions: { parser: false },
    },
    processor: vue.processors['.vue'],
    plugins: { vue },
    rules: {
      'vue/no-parsing-error': 'error',
      'vue/no-duplicate-attributes': 'error',
      'vue/valid-template-root': 'error',
      'vue/valid-v-if': 'error',
      'vue/valid-v-for': 'error',
      'vue/require-v-for-key': 'error',
      'vue/no-v-html': 'error',
    },
  },
];
