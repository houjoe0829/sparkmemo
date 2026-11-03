import { moment as hostMoment } from 'obsidian';
import type { Moment, MomentInput } from 'moment';

/** Keep Obsidian's existing runtime instance callable in either TS interop mode. */
export function createMoment(input?: MomentInput): Moment {
  // The SDK declares a namespace import, which loses call signatures with interop enabled.
  // This restores the library's callable type without importing a second runtime copy.
  const factory: unknown = hostMoment;
  return (factory as typeof import('moment'))(input);
}
