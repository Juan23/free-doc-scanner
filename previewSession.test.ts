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
  const stored = session.store(filter(1), (f) => applied.push(f.strength), { untilPageLoads: true });

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
  const stored = session.store(filter(1), () => {}, { untilPageLoads: true });
  runs[0].endFinish();
  await stored;
  const clearedBefore = events.cleared;

  session.subjectChanged();
  expect(events.cleared).toBe(clearedBefore);
  session.pageLoaded();
  expect(events.cleared).toBe(clearedBefore + 1);
});

it('warms one fresh run after a store, which hiding stops and leaving stops too', async () => {
  const { session, runs, start } = setup();
  session.preview(filter(1), start);
  const stored = session.store(filter(1), () => {});
  runs[0].endFinish();
  await stored;

  session.warm(filter(1), start);
  session.warm(filter(1), start);
  expect(runs.length).toBe(2);
  expect(runs[1].warmed).toEqual([1]);

  session.leave();
  expect(runs[1].stopped).toBe(true);
});

it('reports finishing on while a lift catches up and off once its store starts', async () => {
  const { session, runs, events, start } = setup();
  session.preview(filter(1), start);
  const stored = session.store(filter(1), () => {});
  expect(events.finishing).toEqual([true]);
  runs[0].endFinish();
  await stored;
  expect(events.finishing).toEqual([true, false]);
});
