import type { Filter } from './clean';

/** What the session needs of a strengthPreview run. */
export type PreviewRun = {
  preview(filter: Filter): void;
  warm(filter: Filter): void;
  stop(): void;
  finish(filter: Filter): Promise<void>;
};

/**
 * The order of a strength preview's life around the store that a lift starts: one run at a time, the
 * lift's own strength drawn before the photo is freed for the store, only the first lift stored while
 * its preview catches up, and in the editor the preview kept until the pager has loaded the stored
 * page. `clear` takes the preview off the screen; `finishing` reports the catch-up after a lift.
 */
export function previewSession(events: { clear: () => void; finishing: (on: boolean) => void }) {
  let run: PreviewRun | null = null;
  // The run catching up to a lift's strength; hiding stops it too, so nothing shows after a close.
  let finishingRun: PreviewRun | null = null;
  let storing = false;
  let awaitingPage = false;
  const stopAll = () => {
    awaitingPage = false;
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
      run ??= start();
      run.preview(filter);
    },
    /** Starts a run that measures the photo without drawing, unless one is running. */
    warm(filter: Filter, start: () => PreviewRun) {
      if (run) return;
      run = start();
      run.warm(filter);
    },
    hide,
    // Slider events can still arrive while the preview catches up after the lift; only the lift's own value is stored.
    async store(filter: Filter, apply: (filter: Filter) => void, options?: { untilPageLoads: boolean }) {
      if (storing) return;
      storing = true;
      const current = run;
      run = null;
      finishingRun = current;
      try {
        if (current) {
          events.finishing(true);
          await current.finish(filter);
        }
        const stillShown = current !== null && finishingRun === current;
        finishingRun = null;
        awaitingPage = !!options?.untilPageLoads && stillShown;
        apply(filter);
      } finally {
        if (current) events.finishing(false);
        storing = false;
      }
    },
    /** The edited page, another page, or a closed panel: ends the preview unless it waits for the page. */
    subjectChanged() {
      if (!awaitingPage) hide();
    },
    pageLoaded() {
      if (!awaitingPage) return;
      awaitingPage = false;
      events.clear();
    },
    /** The screen is going away: stops every run without clearing the screen. */
    leave: stopAll,
  };
}
