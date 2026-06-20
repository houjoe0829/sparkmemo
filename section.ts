/**
 * Shared section + timestamp utilities.
 *
 * Used by both the editor extensions in `main.ts` and the capture sidebar
 * view in `capture-view.ts`. Keeps the source of truth for section detection
 * and timestamp parsing in one place.
 */

import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, DecorationSet } from '@codemirror/view';

// ── Types & defaults ────────────────────────────────────────────────────────

export interface JournalPartnerSettings {
  /** The heading text that activates the plugin (without # symbols) */
  targetHeading: string;
  /** Heading level: 1 → #, 2 → ##, … */
  headingLevel: number;
  /** Regex pattern whose first match (or capture group 1) is the timestamp */
  timestampPattern: string;
  /** Foreground color of the timestamp badge */
  timestampColor: string;
  /** Background color of the timestamp badge */
  timestampBgColor: string;
  /** When true, editing a timestamp in the editor is blocked */
  readonlyTimestamps: boolean;
  /** When true, pressing Enter inside the journal section auto-inserts a timestamp on the new line */
  autoTimestamp: boolean;
  /** When true, render checkboxes as circles instead of squares */
  circularCheckboxes: boolean;
  /** Capture view: timeline sort direction (true = newest first) */
  captureSortDesc: boolean;
}

export const DEFAULT_SETTINGS: JournalPartnerSettings = {
  targetHeading: 'Journal',
  headingLevel: 2,
  timestampPattern: '\\d{2}:\\d{2}',
  timestampColor: '#7c3aed',
  timestampBgColor: '#ede9fe',
  readonlyTimestamps: true,
  autoTimestamp: true,
  circularCheckboxes: false,
  captureSortDesc: true,
};

export type Rng = { from: number; to: number };

/** A single parsed timeline entry from the journal section. */
export interface JournalEntry {
  /** Raw timestamp text, e.g. "16:17" */
  timestamp: string;
  /** Body text after the timestamp, may include continuation from indented child lines */
  text: string;
  /** Source line index inside the section (0-based, for stable ordering) */
  lineIndex: number;
}

// ── Section detection ──────────────────────────────────────────────────────

/**
 * Find the character range occupied by the body of a heading section.
 * Returns null if the heading is not found.
 */
export function findSection(
  doc: string,
  headingName: string,
  headingLevel: number,
): Rng | null {
  const prefix = '#'.repeat(headingLevel) + ' ';
  const lines = doc.split('\n');
  let charOffset = 0;
  let startOffset = -1;

  for (const line of lines) {
    if (startOffset === -1) {
      if (
        line.startsWith(prefix) &&
        line.slice(prefix.length).trim() === headingName
      ) {
        // Section body starts on the next line
        startOffset = charOffset + line.length + 1;
      }
    } else {
      // A heading of the same level or higher ends the section
      const m = line.match(/^(#+)\s/);
      if (m && m[1].length <= headingLevel) {
        return { from: startOffset, to: charOffset };
      }
    }
    charOffset += line.length + 1;
  }

  return startOffset === -1 ? null : { from: startOffset, to: doc.length };
}

/**
 * Collect the document character ranges that contain timestamp text inside
 * the target section.
 */
export function getTimestampRanges(
  doc: string,
  settings: JournalPartnerSettings,
): Rng[] {
  const section = findSection(
    doc,
    settings.targetHeading,
    settings.headingLevel,
  );
  if (!section) return [];

  // Match optional list-marker prefix, then capture the timestamp
  const linePattern = new RegExp(
    `^(?:[-*+]\\s+)?(${settings.timestampPattern})(?=\\s|$)`,
  );

  const sectionText = doc.slice(section.from, section.to);
  const lines = sectionText.split('\n');
  const result: Rng[] = [];
  let offset = section.from;

  for (const line of lines) {
    const m = linePattern.exec(line);
    if (m?.[1] !== undefined) {
      const prefixLen = m[0].length - m[1].length;
      const from = offset + (m.index ?? 0) + prefixLen;
      result.push({ from, to: from + m[1].length });
    }
    offset += line.length + 1; // +1 for the newline character
  }

  return result;
}

/** Generate a timestamp string for the current local time in HH:MM format. */
export function generateTimestamp(): string {
  const now = new Date();
  return (
    String(now.getHours()).padStart(2, '0') +
    ':' +
    String(now.getMinutes()).padStart(2, '0')
  );
}

/** Build a CM6 DecorationSet that marks every timestamp in the target section. */
export function buildDecorations(
  doc: string,
  settings: JournalPartnerSettings,
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const mark = Decoration.mark({
    class: 'jp-timestamp',
    inclusiveStart: false,
    inclusiveEnd: false,
  });

  for (const { from, to } of getTimestampRanges(doc, settings)) {
    builder.add(from, to, mark);
  }

  return builder.finish();
}

// ── Capture-view helpers ───────────────────────────────────────────────────

/**
 * Parse the body of a journal section into ordered timeline entries.
 *
 * Rules:
 * - Top-level list items (`- HH:MM ...`, `* HH:MM ...`, `+ HH:MM ...`) become entries
 * - Indented continuation lines (any leading whitespace) are appended to the
 *   previous entry's text, joined with a space — supports markdown soft breaks
 *   produced by `buildEntryLine` for multi-line input
 * - Lines without a timestamp at the top level are skipped
 */
export function parseJournalEntries(
  sectionText: string,
  pattern: string,
): JournalEntry[] {
  const tsRe = new RegExp(`^[-*+]\\s+(${pattern})\\s+(.*)$`);
  const lines = sectionText.split('\n');
  const entries: JournalEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    // Indented line → continuation of previous entry
    if (entries.length > 0 && /^\s+\S/.test(raw)) {
      const cont = raw.replace(/\s{2,}$/, '').trim();
      if (cont.length > 0) {
        entries[entries.length - 1].text += ' ' + cont;
      }
      continue;
    }

    const m = tsRe.exec(raw);
    if (!m) continue;

    // Strip trailing markdown soft-break spaces from the first line text
    const text = m[2].replace(/\s{2,}$/, '').trim();
    entries.push({
      timestamp: m[1],
      text,
      lineIndex: i,
    });
  }

  return entries;
}

/**
 * Construct a journal entry line to append to the section.
 *
 * Single-line input becomes `- HH:MM text`.
 * Multi-line input uses markdown soft-breaks (two trailing spaces) so the
 * entry stays inside the same list item:
 *
 *   - 16:17 first line
 *     second line
 *     third line
 *
 * Each line (except possibly the last) ends with two spaces to render as a
 * soft break in markdown. Continuation lines are indented with two spaces so
 * they belong to the same list item.
 */
export function buildEntryLine(text: string, ts: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return `- ${ts} `;

  const parts = trimmed.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (parts.length === 1) {
    return `- ${ts} ${parts[0]}`;
  }

  const head = `- ${ts} ${parts[0]}  `;
  const tail = parts
    .slice(1)
    .map((line, idx) =>
      idx === parts.length - 2 ? `  ${line}` : `  ${line}  `,
    );
  return [head, ...tail].join('\n');
}

/**
 * Append a built entry line to the journal section of `content`.
 *
 * - If the section exists, the line is inserted at the section's end (just
 *   before the next heading of the same/higher level, or end-of-file).
 * - If the section does not exist, the heading + line are appended to the
 *   end of the document.
 *
 * Whitespace handling: the result always has exactly one trailing newline
 * after the inserted line, and no duplicated blank lines stacked at the
 * insertion point.
 */
export function appendToJournalSection(
  content: string,
  settings: JournalPartnerSettings,
  line: string,
): string {
  const section = findSection(
    content,
    settings.targetHeading,
    settings.headingLevel,
  );

  if (!section) {
    // Section absent — create it at the end of the document
    const prefix = '#'.repeat(settings.headingLevel) + ' ' + settings.targetHeading;
    const sep = content.length === 0 || content.endsWith('\n') ? '' : '\n';
    const headingBlock = `${sep}\n${prefix}\n${line}\n`;
    return content + headingBlock;
  }

  // Section exists — insert just before section.to.
  // Trim any trailing blank-line run at the insertion point so we don't
  // accumulate empty lines on every append.
  const before = content.slice(0, section.to);
  const after = content.slice(section.to);

  const beforeTrimmed = before.replace(/\n+$/, '');
  const insertion = `\n${line}\n`;

  if (after.length === 0) {
    return beforeTrimmed + insertion;
  }
  // `after` starts at the next heading line — prepend a blank-line separator
  return beforeTrimmed + insertion + '\n' + after;
}
