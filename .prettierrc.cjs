// Resolve the shell plugin from the frontend package, including in root editors.
module.exports = {
  trailingComma: 'es5',
  printWidth: 80,
  tabWidth: 2,
  semi: true,
  singleQuote: true,
  plugins: [require('./web/node_modules/prettier-plugin-sh')],
  overrides: [
    {
      files: ['*.jsonc', '**/tsconfig*.json', '.vscode/*.json'],
      options: {
        parser: 'jsonc',
        trailingComma: 'none',
      },
    },
  ],
};
