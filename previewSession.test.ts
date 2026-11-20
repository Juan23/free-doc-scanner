import { previewSession, type PreviewRun } from './previewSession';

// A run that records what it was asked, and finishes when the test says so.
function fakeRun() {
  let resolveFinish!: () => void;
  const run = {
    previews: [] as number[],
    warmed: [] as number[],
    stopped: false,
    finished: [] as number[],
    preview: (f: { strength: number }) => void run.previews.push(f.strength),
    warm: (f: { strength: number }) => void run.warmed.push(f.strength),
    stop: () => void (run.stopped = true),
    isStopped: () => run.stopped,
    finish: (f: { strength: number }) => {
      run.finished.push(f.strength);
      return new Promise<void>((r) => (resolveFinish = r));
    },
    endFinish: () => resolveFinish(),
  };
  return run;
}

const filter = (strength: number) => ({ kind: 'clean' as const, strength });

function setup() {
  const runs: ReturnType<typeof fakeRun>[] = [];
  const events = { cleared: 0, finishing: [] as boolean[] };
  const session = previewSession({
    clear: () => void events.cleared++,
    finishing: (on) => void events.finishing.push(on),
  });
  const start = (): PreviewRun => {
    const run = fakeRun();
    runs.push(run);
    return run;
  };
  return { session, runs, events, start };
}

it('stores only the first lift while its preview catches up, after the preview has finished', async () => {
  const { session, runs, start } = setup();
  const applied: number[] = [];
  session.preview(filter(1.5), start);

  const first = session.store(filter(1.5), (f) => applied.push(f.strength));
  void session.store(filter(2), (f) => applied.push(f.strength));
  expect(applied).toEqual([]);
  runs[0].endFinish();
  await first;

  expect(runs[0].finished).toEqual([1.5]);
  expect(applied).toEqual([1.5]);
});

it('stops the catching-up preview when hidden mid-store, still stores, and does not wait for the page', async () => {
  const { session, runs, events, start } = setup();
  const applied: number[] = [];
  session.preview(filter(1), start);
  const stored = session.store(filter(1), (f) => applied.push(f.strength), { keep: 'untilPageLoads' });

  session.hide();
  runs[0].endFinish();
  await stored;
  const clearedBefore = events.cleared;
  session.subjectChanged();

  expect(runs[0].stopped).toBe(true);
  expect(applied).toEqual([1]);
  // Not waiting for the page: the subject change clears it as usual.
  expect(events.cleared).toBe(clearedBefore + 1);
});

it('in the editor, keeps the preview past the stored subject change until the page loads', async () => {
  const { session, runs, events, start } = setup();
  session.preview(filter(1), start);
  const stored = session.store(filter(1), () => {}, { keep: 'untilPageLoads' });
  runs[0].endFinish();
  await stored;
  const clearedBefore = events.cleared;

  session.subjectChanged();
  expect(events.cleared).toBe(clearedBefore);
  session.pageLoaded();
  expect(events.cleared).toBe(clearedBefore + 1);
});

it('warms one fresh run after a store, which hiding stops', async () => {
  const { session, runs, start } = setup();
  session.preview(filter(1), start);
  const stored = session.store(filter(1), () => {});
  runs[0].endFinish();
  await stored;

  session.warm(filter(1), start);
  session.warm(filter(1), start);
  expect(runs.length).toBe(2);
  expect(runs[1].warmed).toEqual([1]);

  session.hide();
  expect(runs[1].stopped).toBe(true);
});

it('stops every run when the screen goes away', () => {
  const { session, runs, start } = setup();
  session.warm(filter(1), start);
  session.leave();
  expect(runs[0].stopped).toBe(true);
});

it('ends the preview at a second subject change while waiting for the page, such as a turn', async () => {
  const { session, runs, events, start } = setup();
  session.preview(filter(1), start);
  const stored = session.store(filter(1), () => {}, { keep: 'untilPageLoads' });
  runs[0].endFinish();
  await stored;
  session.subjectChanged();
  session.warm(filter(1), start);
  const clearedBefore = events.cleared;

  session.subjectChanged();

  expect(events.cleared).toBe(clearedBefore + 1);
  expect(runs[1].stopped).toBe(true);
});

it('reports finishing on while a lift catches up and off once its save ends', async () => {
  const { session, runs, events, start } = setup();
  session.preview(filter(1), start);
  const stored = session.store(filter(1), () => {});
  expect(events.finishing).toEqual([true]);
  runs[0].endFinish();
  await stored;
  expect(events.finishing).toEqual([true, false]);
});

it('warms nothing while a store runs, through the save itself', async () => {
  const { session, runs, start } = setup();
  let endSave!: () => void;
  session.preview(filter(1), start);
  const stored = session.store(filter(1), () => new Promise<void>((r) => (endSave = r)));
  session.warm(filter(1), start);
  runs[0].endFinish();
  await Promise.resolve();
  session.warm(filter(1), start);
  expect(runs.length).toBe(1);

  endSave();
  await stored;
  session.warm(filter(1), start);
  expect(runs.length).toBe(2);
});

it('replaces a run that stopped by itself, such as after a failed pass', () => {
  const { session, runs, start } = setup();
  session.preview(filter(1), start);
  runs[0].stopped = true;

  session.preview(filter(2), start);

  expect(runs.length).toBe(2);
  expect(runs[1].previews).toEqual([2]);
});

it('in Select mode, keeps the stored strength shown past the store until the next change', async () => {
  const { session, runs, events, start } = setup();
  session.preview(filter(1), start);
  const stored = session.store(filter(1), () => {}, { keep: 'untilNextChange' });
  runs[0].endFinish();
  await stored;
  const clearedBefore = events.cleared;

  session.subjectChanged();
  expect(events.cleared).toBe(clearedBefore);
  session.subjectChanged();
  expect(events.cleared).toBe(clearedBefore + 1);
});

it('clears the preview when the store is turned away', async () => {
  const { session, runs, events, start } = setup();
  session.preview(filter(1), start);
  const stored = session.store(filter(1), async () => false, { keep: 'untilPageLoads' });
  runs[0].endFinish();
  const clearedBefore = events.cleared;
  await stored;

  expect(events.cleared).toBe(clearedBefore + 1);
  session.subjectChanged();
  session.pageLoaded();
  expect(events.cleared).toBe(clearedBefore + 2);
});

it('after a run fails by itself, warms nothing until the subject changes, but a move still retries', () => {
  const { session, runs, start } = setup();
  session.preview(filter(1), start);
  runs[0].stopped = true;

  session.warm(filter(1), start);
  expect(runs.length).toBe(1);
  session.preview(filter(2), start);
  expect(runs.length).toBe(2);

  runs[1].stopped = true;
  session.subjectChanged();
  session.warm(filter(1), start);
  expect(runs.length).toBe(3);
});

it('does not finish a warm run or wait for the page when nothing is on screen', async () => {
  const { session, runs, events, start } = setup();
  const applied: number[] = [];
  session.warm(filter(1), start);

  const stored = session.store(filter(1.6), (f) => applied.push(f.strength), { keep: 'untilPageLoads' });

  expect(runs[0].finished).toEqual([]);
  expect(runs[0].stopped).toBe(true);
  expect(events.finishing).toEqual([]);
  await stored;
  expect(applied).toEqual([1.6]);
});

it('in Select mode, a store on a warm run after a previous lift finishes with the new strength', async () => {
  const { session, runs, events, start } = setup();
  session.preview(filter(1), start);
  const first = session.store(filter(1.5), () => {}, { keep: 'untilNextChange' });
  runs[0].endFinish();
  await first;
  session.subjectChanged();

  session.warm(filter(1.5), start);
  const second = session.store(filter(1.6), () => {}, { keep: 'untilNextChange' });
  expect(runs[1].finished).toEqual([1.6]);
  expect(events.finishing).toEqual([true, false, true]);
  runs[1].endFinish();
  await second;
});

it('a new move ends the previous store\'s wait for the page', async () => {
  const { session, runs, events, start } = setup();
  session.preview(filter(1), start);
  const stored = session.store(filter(1), () => {}, { keep: 'untilPageLoads' });
  runs[0].endFinish();
  await stored;
  session.subjectChanged();
  const clearedBefore = events.cleared;

  session.preview(filter(1.5), start);
  session.pageLoaded();

  expect(events.cleared).toBe(clearedBefore);
});

it('hiding for a swipe does not start a warm-up or reset failed state', () => {
  const { session, runs, start } = setup();
  session.preview(filter(1), start);
  session.swipe();
  session.warm(filter(1), start);
  expect(runs.length).toBe(1);

  const failedSwipe = setup();
  failedSwipe.session.preview(filter(1), failedSwipe.start);
  failedSwipe.runs[0].stopped = true;
  failedSwipe.session.swipe();
  failedSwipe.session.warm(filter(1), failedSwipe.start);
  expect(failedSwipe.runs.length).toBe(1);

  const failedHide = setup();
  failedHide.session.preview(filter(1), failedHide.start);
  failedHide.runs[0].stopped = true;
  failedHide.session.hide();
  failedHide.session.warm(filter(1), failedHide.start);
  expect(failedHide.runs.length).toBe(1);
});

it('does not hand a run that stopped by itself to the store', async () => {
  const { session, runs, start } = setup();
  session.preview(filter(1), start);
  runs[0].stopped = true;

  await session.store(filter(1), () => {});

  expect(runs[0].finished).toEqual([]);
});
