import { liveImages } from './liveImages';

const disposeNow = (images: { dispose: () => void }[]) => images.forEach((image) => image.dispose());

const image = (name: string) => ({ name, dispose: jest.fn() });

it('frees the images handed over before the one on screen, and never a later one', () => {
  const list = liveImages(disposeNow);
  const a = image('a');
  const b = image('b');
  const c = image('c');
  list.add(a);
  const upToB = list.add(b);
  list.add(c);

  // b is on screen; c was handed over after that render and may not be drawn yet.
  list.release(upToB, b);

  expect(a.dispose).toHaveBeenCalledTimes(1);
  expect(b.dispose).not.toHaveBeenCalled();
  expect(c.dispose).not.toHaveBeenCalled();
});

it('frees each image once, however often it is released', () => {
  const list = liveImages(disposeNow);
  const a = image('a');
  const b = image('b');
  list.add(a);
  const upToB = list.add(b);

  list.release(upToB, b);
  list.release(upToB, b);
  list.release(upToB, null);

  expect(a.dispose).toHaveBeenCalledTimes(1);
  expect(b.dispose).toHaveBeenCalledTimes(1);
});

it('frees every image left when cleared', () => {
  const list = liveImages(disposeNow);
  const a = image('a');
  const b = image('b');
  list.add(a);
  list.add(b);

  list.clear();

  expect(a.dispose).toHaveBeenCalledTimes(1);
  expect(b.dispose).toHaveBeenCalledTimes(1);
});
