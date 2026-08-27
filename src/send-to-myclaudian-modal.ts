import { App, Modal } from 'obsidian';
import { t } from './i18n';
import { getMyClaudian } from './myclaudian-bridge';
import { notice } from './notice';

export interface MemoSeed {
  /** `HH:MM` as written in the journal. */
  timestamp: string;
  /** `YYYY-MM-DD`. */
  date: string;
  /** Raw markdown body, without the `- HH:MM` prefix. */
  text: string;
  /**
   * Vault-relative path of the daily note this memo lives in, or null when the day
   * has no file behind it. Sent along so the conversation is recorded under that
   * note's 「与此相关」 rather than floating free of where it came from.
   */
  notePath: string | null;
}

/**
 * One-tap prompts, sent immediately rather than dropped into the box. They exist
 * for the common case where the user wants the memo pushed somewhere and has no
 * instruction of their own to add.
 *
 * A memo is a thought the user already finished having, so none of these ask for
 * an explanation of it: being told what you just wrote is worth nothing. They push
 * outward instead — extend it, question it, or connect it to older notes.
 *
 * Deliberately not routed through `i18n.ts`: the user writes memos in Chinese and
 * wants the replies in Chinese, regardless of what language Obsidian's UI is set to.
 *
 * `label` is what fits on a button; `prompt` is what actually goes out. The extra
 * clause in each prompt is load-bearing — without it a short instruction reads to
 * the model as "summarise this", which is the one thing these are meant to avoid.
 */
const SUGGESTIONS: ReadonlyArray<{ label: string; prompt: string }> = [
  {
    label: '顺着这个往下想，还能推出什么',
    prompt: '顺着这条往下想，还能推出什么？不用复述我写的，直接往外推。',
  },
  {
    label: '顺着这条追问我',
    prompt: '顺着这条追问我，一次问一个问题，帮我把没想透的地方挖出来。',
  },
  {
    label: '找找库里跟这条呼应的旧想法',
    prompt: '在我的 vault 里找找跟这条呼应或者冲突的旧想法，说说它们之间是什么关系。',
  },
];

/**
 * Compose the message MyClaudian receives. The memo travels as a blockquote under
 * a source line, so the model can tell the user's instruction apart from the text
 * being discussed without either being labelled with tags it might try to answer in.
 */
function composeMessage(prompt: string, seed: MemoSeed): string {
  const quoted = seed.text
    .split('\n')
    .map(line => (line ? `> ${line}` : '>'))
    .join('\n');
  const source = t('myclaudian.source', { date: seed.date, time: seed.timestamp });
  return [prompt.trim(), '', source, quoted].filter((part, i) => i > 0 || part).join('\n');
}

/**
 * Composer for the "Send to MyClaudian" entry: shows the memo, takes an optional
 * instruction, and hands the whole thing to MyClaudian as a fresh conversation.
 */
export class SendToMyClaudianModal extends Modal {
  private seed: MemoSeed;
  private inputEl!: HTMLTextAreaElement;
  private suggestionsEl!: HTMLElement;
  private sendBtn!: HTMLButtonElement;
  private sending = false;

  constructor(app: App, seed: MemoSeed) {
    super(app);
    this.seed = seed;
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText(t('myclaudian.title'));
    contentEl.addClass('jp-mc-modal');
    // On the shell rather than the content: Obsidian's default modal width is set
    // there, so narrowing it from the inside has no effect.
    this.modalEl.addClass('jp-mc-modal-shell');

    // Read-only echo of what is being sent. Without it the dialog would ask the
    // user to write an instruction about a memo they can no longer see.
    const memoEl = contentEl.createDiv({ cls: 'jp-mc-memo' });
    memoEl.createDiv({
      cls: 'jp-mc-memo-meta',
      text: `${t('myclaudian.memoLabel')} · ${this.seed.date} ${this.seed.timestamp}`,
    });
    memoEl.createDiv({ cls: 'jp-mc-memo-body', text: this.seed.text });

    this.inputEl = contentEl.createEl('textarea', {
      cls: 'jp-mc-input',
      // No `rows`: themes routinely override textarea height, and this one was
      // coming out at roughly seven times the requested size. CSS sets it instead.
      attr: { placeholder: t('myclaudian.inputPlaceholder') },
    });
    this.inputEl.addEventListener('input', () => this.syncSuggestions());
    this.inputEl.addEventListener('keydown', event => {
      // Enter sends, matching every other composer the user touches; newlines
      // stay reachable through shift.
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void this.send(this.inputEl.value);
      }
    });

    this.suggestionsEl = contentEl.createDiv({ cls: 'jp-mc-suggestions' });
    for (const suggestion of SUGGESTIONS) {
      const btn = this.suggestionsEl.createEl('button', {
        cls: 'jp-mc-suggestion',
        text: `→ ${suggestion.label}`,
      });
      btn.addEventListener('click', () => void this.send(suggestion.prompt));
    }

    const actions = contentEl.createDiv({ cls: 'jp-mc-actions' });
    this.sendBtn = actions.createEl('button', {
      cls: 'mod-cta jp-mc-send',
      text: t('myclaudian.send'),
    });
    this.sendBtn.addEventListener('click', () => void this.send(this.inputEl.value));

    window.setTimeout(() => this.inputEl.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }

  /** Suggestions are for an empty box; once the user writes their own they are noise. */
  private syncSuggestions(): void {
    this.suggestionsEl.toggleClass('is-hidden', this.inputEl.value.trim().length > 0);
  }

  private async send(prompt: string): Promise<void> {
    if (this.sending) return;
    const plugin = getMyClaudian(this.app);
    // Re-checked at send time rather than trusted from when the menu was built:
    // MyClaudian can be disabled while this dialog sits open.
    if (!plugin) {
      notice(t('myclaudian.unavailable'));
      this.close();
      return;
    }

    this.sending = true;
    this.sendBtn.disabled = true;
    this.sendBtn.setText(t('myclaudian.sending'));
    try {
      const ok = await plugin.sendFromPlugin({
        text: composeMessage(prompt, this.seed),
        startNew: true,
        notePaths: this.seed.notePath ? [this.seed.notePath] : undefined,
      });
      if (!ok) {
        notice(t('myclaudian.failed'));
        return;
      }
      notice(`✅ ${t('myclaudian.sent')}`);
      this.close();
    } catch (error) {
      notice(`❌ ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.sending = false;
      this.sendBtn.disabled = false;
      this.sendBtn.setText(t('myclaudian.send'));
    }
  }
}
