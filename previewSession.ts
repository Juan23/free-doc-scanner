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

export function previewSession(events: { clear: () => void; finishing: (on: boolean) => void }) {
  let run: PreviewRun | null = null;
  // Hiding also stops the catching-up run so nothing shows after a close.
  let finishingRun: PreviewRun | null = null;
  let storing = false;
  // After a store, waits for its own subject change before waiting for the page.
  let awaiting: 'subject' | 'page' | null = null;
  let keep: Keep | null = null;
  // Keeps a failed run from retrying on warm-up until the subject changes.
  let failed = false;
  let shown = false;
  let noWarm = false;
  const dropStopped = () => {
    if (!run?.isStopped()) return run;
    failed = true;
    shown = false;
    run = null;
    return null;
  };
  const stopAll = () => {
    dropStopped();
    awaiting = null;
    shown = false;
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
      awaiting = null;
      noWarm = false;
      shown = true;
      run = dropStopped() ?? start();
      run.preview(filter);
    },
    warm(filter: Filter, start: () => PreviewRun) {
      if (dropStopped() || storing || failed || noWarm) return;
      run = start();
      run.warm(filter);
    },
    hide,
    swipe() {
      noWarm = true;
      hide();
    },
    // Only the first lift stores while catching up; `apply` returns false when turned away or failed.
    async store(filter: Filter, apply: (filter: Filter) => unknown, options?: { keep: Keep }) {
      if (storing) return;
      storing = true;
      noWarm = false;
      const lifted = dropStopped();
      run = null;
      const finishNeeded = shown && lifted !== null;
      finishingRun = finishNeeded ? lifted : null;
      try {
        if (finishNeeded) {
          events.finishing(true);
          await lifted.finish(filter);
        } else {
          lifted?.stop();
        }
        const stillShown = finishNeeded && finishingRun === lifted;
        finishingRun = null;
        keep = options?.keep ?? null;
        awaiting = keep && stillShown ? 'subject' : null;
        if ((await apply(filter)) === false) hide();
      } finally {
        if (finishNeeded) events.finishing(false);
        storing = false;
      }
    },
    subjectChanged() {
      noWarm = false;
      if (awaiting !== 'subject') {
        hide();
        failed = false;
        return;
      }
      failed = false;
      awaiting = keep === 'untilPageLoads' ? 'page' : null;
    },
    pageLoaded() {
      if (awaiting !== 'page') return;
      awaiting = null;
      shown = false;
      events.clear();
    },
    leave: stopAll,
  };
}
