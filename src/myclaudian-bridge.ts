import type { App } from 'obsidian';

/** Plugin id of MyClaudian. Nothing else is accepted: the entry point exists to reach that one plugin. */
const MYCLAUDIAN_ID = 'myclaudian';

interface MyClaudianPlugin {
  sendFromPlugin(input: {
    text: string;
    startNew?: boolean;
    notePaths?: readonly string[];
  }): Promise<boolean>;
}

interface PluginRegistry {
  plugins?: { plugins?: Record<string, unknown> };
}

/**
 * Resolve MyClaudian's plugin instance, or null when it is missing, disabled, or
 * predates `sendFromPlugin`. Duck-typing the method rather than trusting the id
 * alone also covers the version gap: an older MyClaudian is present but cannot be
 * sent to, and offering the entry point would just produce a dead menu item.
 */
export function getMyClaudian(app: App): MyClaudianPlugin | null {
  const registry = app as unknown as PluginRegistry;
  const plugin = registry.plugins?.plugins?.[MYCLAUDIAN_ID] as Partial<MyClaudianPlugin> | undefined;
  if (typeof plugin?.sendFromPlugin !== 'function') return null;
  return plugin as MyClaudianPlugin;
}

/** True when the "Send to MyClaudian" entry has somewhere to send to. */
export function isMyClaudianAvailable(app: App): boolean {
  return getMyClaudian(app) !== null;
}
