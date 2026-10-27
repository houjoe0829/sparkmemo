import obsidianmd from 'eslint-plugin-obsidianmd';

export default [
  { ignores: ['dist/**', 'release/**', '.claude/**'] },
  ...obsidianmd.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      globals: { __PLUGIN_VERSION__: 'readonly', __BUILD_NUMBER__: 'readonly' },
      parserOptions: { projectService: true },
    },
  },
];
