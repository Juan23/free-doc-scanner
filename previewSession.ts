import type { Filter } from './clean';

/** What the session needs of a strengthPreview run. */
export type PreviewRun = {
  preview(filter: Filter): void;
  warm(filter: Filter): void;
  stop(): void;
  /** True once stopped, by `stop` or by a failed pass. */
  isStopped(): boolean;
  finish(filter: Filter): Promise<void>;
};

type Keep = 'untilPageLoads' | 'untilNextChange';

/**
 * The order of a strength preview's life around the store that a lift starts: one run at a time, the
 * lift's own strength drawn before the photo is freed for the store, only the first lift stored while
 * its preview catches up and its save runs, and the preview then kept until the pager has loaded the
 * stored page (the editor) or until the next change (Select mode). `clear` takes the preview off the
 * screen; `finishing` reports the catch-up after a lift.
 */
export function previewSession(events: { clear: () => void; finishing: (on: boolean) => void }) {
  let run: PreviewRun | null = null;
  // The run catching up to a lift's strength; hiding stops it too, so nothing shows after a close.
  let finishingRun: PreviewRun | null = null;
  let storing = false;
  // After a store: 'subject' until the store's own subject change, then 'page' until the pager shows it.
  let awaiting: 'subject' | 'page' | null = null;
  let keep: Keep | null = null;
  // A run stopped by itself (a failed pass): no warm-up until the subject changes, or it would retry forever.
  let failed = false;
  const current = () => {
    if (!run?.isStopped()) return run;
    failed = true;
    run = null;
    return null;
  };
  const stopAll = () => {
    awaiting = null;
    failed = false;
    finishingRun?.stop();
    finishingRun = null;
    run?.stop();
    run = null;
  };
  const hide = () => {
    stopAll();
    events.clear();
  };
  return {
    preview(filter: Filter, start: () => PreviewRun) {
      run = current() ?? start();
      run.preview(filter);
    },
    /** Starts a run that measures the photo without drawing, unless one is running or a store is. */
    warm(filter: Filter, start: () => PreviewRun) {
      if (current() || storing || failed) return;
      run = start();
      run.warm(filter);
    },
    hide,
    // Slider events can still arrive while the preview catches up after the lift; only the lift's own value is stored.
    // `apply` resolves to false when the store was turned away (another action held the queue) or failed.
    async store(filter: Filter, apply: (filter: Filter) => unknown, options?: { keep: Keep }) {
      if (storing) return;
      storing = true;
      const lifted = current();
      run = null;
      finishingRun = lifted;
      try {
        if (lifted) {
          events.finishing(true);
          await lifted.finish(filter);
        }
        const stillShown = lifted !== null && finishingRun === lifted;
        finishingRun = null;
        keep = options?.keep ?? null;
        awaiting = keep && stillShown ? 'subject' : null;
        if ((await apply(filter)) === false) hide();
      } finally {
        if (lifted) events.finishing(false);
        storing = false;
      }
    },
    /** The edited page, another page, a turn or a closed panel: ends the preview, except the store's own change. */
    subjectChanged() {
      failed = false;
      if (awaiting !== 'subject') return hide();
      awaiting = keep === 'untilPageLoads' ? 'page' : null;
    },
    pageLoaded() {
      if (awaiting !== 'page') return;
      awaiting = null;
      events.clear();
    },
    /** The screen is going away: stops every run without clearing the screen. */
    leave: stopAll,
  };
}
