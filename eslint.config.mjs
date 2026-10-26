import obsidianmd from 'eslint-plugin-obsidianmd';

export default [
  { ignores: ['dist/**', 'release/**', '.claude/**'] },
  ...obsidianmd.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true },
    },
  },
];
