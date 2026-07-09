import { Notice, setIcon } from 'obsidian';

const EMOJI_ICON_MAP: Array<[string, string]> = [
  ['⚠️', 'alert-triangle'],
  ['❌', 'x'],
  ['✅', 'check'],
  ['⏰', 'clock'],
  ['🕒', 'clock'],
  ['📋', 'clipboard'],
  ['🗑️', 'trash-2'],
  ['🎙️', 'mic'],
  ['✏️', 'pencil'],
  ['📅', 'calendar'],
  ['🗜️', 'archive'],
];

function parseLeadingIcon(message: string): { icon: string | null; text: string } {
  for (const [emoji, icon] of EMOJI_ICON_MAP) {
    if (message.startsWith(emoji)) {
      return { icon, text: message.slice(emoji.length).trimStart() };
    }
  }
  return { icon: null, text: message };
}

export function notice(message: string, timeout?: number): Notice {
  const { icon, text } = parseLeadingIcon(message);
  if (!icon) return new Notice(message, timeout);

  const frag = document.createDocumentFragment();
  const wrap = frag.createSpan({ cls: 'jp-notice' });
  const iconEl = wrap.createSpan({ cls: 'jp-notice__icon' });
  setIcon(iconEl, icon);
  wrap.createSpan({ cls: 'jp-notice__text', text });
  return new Notice(frag, timeout);
}
