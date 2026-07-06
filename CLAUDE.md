# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

**Spark Memo** is an Obsidian plugin for journaling. It highlights and manages `HH:MM` timestamps in a designated Memo section, provides a quick-capture sidebar (record / search / locations / stats) for jotting down text, images, and voice recordings straight into today's daily note, and includes a multi-language (中文/English) UI that follows Obsidian's configured language.

The project started as a fork of [zhaohongxuan/journal-partner](https://github.com/zhaohongxuan/journal-partner) (a single-file timestamp-highlighting plugin) and has since grown well beyond it — the codebase is now split across several modules and the plugin ID/branding is `spark-memo` / Spark Memo, not Journal Partner. When updating docs or comments, prefer "Spark Memo" and "Memo section" over the old naming.

## Build & Development Commands

```bash
# Install dependencies
npm install

# Development mode (watch and rebuild on save)
npm run dev

# Production build (type-check + minified bundle, no sourcemaps)
npm run build

# Deploy to local Obsidian vault (requires configured VAULT_PATH in deploy.sh)
npm run deploy
```

The build pipeline (`scripts/build.js`, esbuild-based):
- **TypeScript** type-checked via `tsc -noEmit` before every build
- **esbuild** bundles `src/main.ts` into CommonJS `main.js`
- External dependencies (`obsidian`, `@codemirror/*`) are excluded from the bundle — provided by Obsidian at runtime
- The `@jsquash/webp` WASM binary is inlined at build time (esbuild's `binary` loader)
- Inline sourcemaps in dev, removed in production
- Output: `main.js` (plugin entry), `styles.css` (styles), `manifest.json` (metadata)

## Architecture

The source is split by concern under `src/`:

- **`main.ts`** — Plugin entry point. Registers the CodeMirror 6 editor extensions (timestamp decorations, read-only enforcement, Enter/Tab keymaps), the reading-view post-processor, the settings tab (`SparkMemoSettingTab`), and the quick-capture sidebar view.
- **`section.ts`** — Shared, Obsidian-light utilities used by both `main.ts` and `capture-view.ts`: the `SparkMemoSettings` interface + `DEFAULT_SETTINGS`, section/timestamp detection (`findSection`, `getTimestampRanges`), entry parsing (`parseJournalEntries`), and the read/write helpers for appending, deleting, and editing journal entries.
- **`capture-view.ts`** — The quick-capture sidebar (`JournalCaptureView`, ~4000 lines). A single `ItemView` with four tab panes:
  - **记录 (Capture)** — multi-line input, image/audio attachments, EXIF-based capture time/GPS confirmation, a continuous-scroll timeline of daily entries.
  - **搜索 (Search)** — lazy-loaded full-text search across all daily notes, plus a "random memo" surprise view.
  - **地点 (Locations)** — aggregates entries carrying a `[name](geo:lat,lon)` tag by city.
  - **统计 (Stats)** — renders the yearly heatmaps computed by `stats.ts`.
- **`stats.ts`** — Pure data layer for the stats tab (deliberately Obsidian-free so it can be unit-tested in isolation). Computes per-year and all-time word/entry/streak counts from raw section text; does not depend on `- HH:MM` formatting.
- **`i18n.ts`** — Minimal translation layer. `t(key, vars?)` looks up `dictionaries.en` / `dictionaries.zh` based on Obsidian's `getLanguage()` (falling back to `moment.locale()`, then English). `currentLocale()` is exported for call sites that need to branch on locale directly (e.g. date/number formatting) rather than just look up a string.
- **`exif.ts`** — Minimal EXIF reader (no dependency) for JPEG capture time + GPS coordinates.
- **`geocode.ts`** — Reverse geocoding via OpenStreetMap Nominatim (free, rate-limited to ~1 req/s).
- **`webp-encoder.ts`** — WASM WebP encoder wrapper (`@jsquash/webp`), used because Safari/iOS can't encode WebP via `canvas.toBlob`.

### Key Design Patterns

**Scoped Rendering:** The plugin only affects a user-specified heading section (default: `## Memo`). All rendering and interaction happens within `findSection()` bounds, computed the same way in both the editor extensions and the capture sidebar.

**Dual-View Architecture (editor side):**
- **Editor View** (Source + Live-Preview): CodeMirror 6 `ViewPlugin` with decorations + a transaction filter for read-only enforcement.
- **Reading View**: A markdown post-processor walks the rendered DOM and wraps timestamps in `<span class="jp-timestamp">`.

Both share the same timestamp detection logic (`section.ts`) but render differently.

**CSS-Driven Styling:** Colors are stored in CSS custom properties (`--jp-ts-color`, `--jp-ts-bg`) applied via `applyCSSVariables()`. Settings changes dispatch a `forceUpdateEffect` to trigger decoration recomputation without reloading. (CSS class names still carry the `jp-` prefix from the original Journal Partner fork — this is internal naming only, not user-facing, and hasn't been renamed.)

**i18n:** All user-visible strings (settings tab, Notice toasts, capture sidebar UI) go through `t()` from `i18n.ts` rather than being hardcoded. When adding new UI text, add matching `en`/`zh` entries to `dictionaries` in `i18n.ts` rather than inlining Chinese (or English) strings directly.

### Critical Functions

- **`findSection(doc, headingName, headingLevel)`** (`section.ts`) — Locates the character range of a heading section by parsing the document line-by-line. Returns `null` if not found.
- **`getTimestampRanges(doc, settings)`** (`section.ts`) — Character ranges for each timestamp in the target section.
- **`buildDecorations(doc, settings)`** (`section.ts`) — Builds the CM6 `DecorationSet` for timestamp badges.
- **`generateTimestamp()`** (`section.ts`) — Current time as `HH:MM`.
- **`t(key, vars?)`** (`i18n.ts`) — Translate a UI string for the current Obsidian language.

## File Structure

- **`src/main.ts`** — Plugin entry: editor extensions, reading-view processor, settings tab.
- **`src/section.ts`** — Settings type/defaults + section & timestamp utilities (shared).
- **`src/capture-view.ts`** — Quick-capture sidebar view (record / search / locations / stats).
- **`src/stats.ts`** — Pure stats computation (Obsidian-free).
- **`src/i18n.ts`** — Translation dictionaries + `t()`/`currentLocale()`.
- **`src/exif.ts`** — EXIF capture time + GPS reader.
- **`src/geocode.ts`** — Reverse geocoding (Nominatim).
- **`src/webp-encoder.ts`** — WASM WebP encoder wrapper.
- **`main.js`** — Compiled output (generated by esbuild).
- **`styles.css`** — Plugin CSS.
- **`manifest.json`** — Obsidian plugin metadata (id: `spark-memo`).
- **`package.json`** — Dependencies: obsidian, @codemirror/{state,view}, obsidian-daily-notes-interface, @jsquash/webp, TypeScript, esbuild.
- **`tsconfig.json`** — TypeScript config (ES2018 target).
- **`esbuild.config.mjs`** / **`scripts/build.js`** — Build configuration.
- **`deploy.sh`** — Local development deploy script (hardcoded Obsidian vault path).

## Settings & Defaults

All settings are defined in `SparkMemoSettings` (`section.ts`) with defaults in `DEFAULT_SETTINGS`:

| Setting | Type | Default | Purpose |
|---|---|---|---|
| `targetHeading` | string | `"Memo"` | Heading text that activates the plugin |
| `headingLevel` | number | `2` | Heading level (1–6, representing # to ######) |
| `timestampPattern` | string | `\d{2}:\d{2}` | Regex for timestamp detection |
| `timestampColor` | string | `#7c3aed` | Timestamp text color |
| `timestampBgColor` | string | `#ede9fe` | Timestamp background color |
| `readonlyTimestamps` | boolean | `true` | Block editing of existing timestamps |
| `autoTimestamp` | boolean | `true` | Auto-insert on Enter in the Memo section |
| `sttEndpoint` / `sttApiKey` / `sttModel` / `sttLanguage` / `sttRealtime` | — | empty / empty / `whisper-1` / `zh` / `true` | Cloud speech-to-text config — currently unused; the settings-tab UI for these is commented out in `main.ts` (local recording only for now) |
| `recordingFolder` | string | `""` | Vault-relative folder for recordings (empty = Obsidian's attachment folder) |
| `imageFolder` | string | `""` | Vault-relative folder for pasted/uploaded images |
| `imageTimeCheck` | boolean | `true` | Prompt to use an image's EXIF time/GPS when it differs from now |
| `imageCompressionEnabled` | boolean | `true` | Compress images (to WebP) before saving |
| `imageCompressionQuality` | number | `0.8` | WebP re-encode quality (0.1–1.0) |
| `imageCompressionMaxSize` | number | `1920` | Max long-edge size in pixels (0 = no limit) |

Settings are persisted via Obsidian's `this.saveData()` / `this.loadData()` API.

## Common Tasks

**Adding a new setting:**
1. Add the field to `SparkMemoSettings` in `section.ts`.
2. Add a default to `DEFAULT_SETTINGS`.
3. Add a `Setting` control in `SparkMemoSettingTab.display()` (`main.ts`), using `t()` for its name/description — add the corresponding `en`/`zh` entries to `i18n.ts`.
4. Call `this.plugin.saveSettings()` in the `onChange` callback.
5. Apply the effect (`refreshEditors()` if it affects decorations, `applyCSSVariables()` if it's a color).

**Adding new UI text:** Never hardcode a Chinese or English string in `main.ts` / `capture-view.ts`. Add a key to both `dictionaries.en` and `dictionaries.zh` in `i18n.ts`, then call `t('namespace.key', { ...vars })`. Keep the existing dot-namespace convention (`capture.*`, `search.*`, `location.*`, `stats.*`, `notice.*`, `settings.*`).

**Modifying timestamp detection:**
- Edit the regex pattern in `getTimestampRanges()` (`section.ts`), or make it configurable via settings (already is, via `timestampPattern`).
- Test with various line formats: `- 06:42 ...`, `* 07:31 ...`, `+ 08:10 ...`, or non-list text starting with a timestamp.

**Changing styles:**
- Edit `styles.css` — no rebuild needed for CSS changes in development.
- Use CSS custom properties for values that change via settings.

**Testing locally:**
- Run `npm run deploy` to build and copy to the configured Obsidian vault.
- Reload the plugin in Obsidian (Cmd+P → "Reload app without saving"), or use the project's `obsidian-deploy` skill, which reloads via the Obsidian CLI automatically.
- Changes are immediately visible; no restart needed.

## Known Implementation Details

- **Line-based timestamp detection:** Pattern matching happens per-line, not globally. A list marker is required on the current line for a timestamp to be detected at line start.
- **DOM mutation in reading view:** Uses `TreeWalker` to find text nodes, then replaces them — preserves existing DOM structure (links, bold text, etc.) within the paragraph.
- **ESBuild externals:** CodeMirror and Obsidian are excluded from the bundle — provided by Obsidian at runtime.
- **Internal `jp-` naming:** CSS classes, some internal type names (`JournalEntry`), and function names (`appendToJournalSection`, `JournalCaptureView`) still carry the original Journal Partner naming. This is intentionally left as-is — it's not user-facing, and a full rename would be a large, purely cosmetic refactor with no functional benefit.
- **i18n locale detection:** `i18n.ts` uses Obsidian's `getLanguage()` (added in Obsidian 1.8.7); on older Obsidian versions where it isn't available, it falls back to `moment.locale()`, then defaults to English.
