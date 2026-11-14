type Disposable = { dispose: () => void };

/**
 * Frees `images` a frame later: a Canvas hands its new drawing to Skia a moment after React commits,
 * and Skia replays the old one first, so an image just taken off the screen may still be drawn once.
 */
export function disposeNextFrame(images: Disposable[]) {
  if (images.length) requestAnimationFrame(() => images.forEach((image) => image.dispose()));
}

/**
 * The preview images handed to the screen, freed (through `free`) only once they can no longer be
 * drawn. Two can be handed over before one render, so each gets a number; `release` frees the ones
 * up to the number a render showed, except the one it shows, and never a later one that render had
 * not seen.
 */
export function liveImages<T extends Disposable>(free: (images: T[]) => void) {
  let held: { image: T; n: number }[] = [];
  let handed = 0;
  return {
    add(image: T): number {
      held.push({ image, n: ++handed });
      return handed;
    },
    lastNumber: () => handed,
    release(upTo: number, onScreen: T | null) {
      const freed = held.filter((e) => e.n <= upTo && e.image !== onScreen);
      held = held.filter((e) => !freed.includes(e));
      free(freed.map((e) => e.image));
    },
    clear() {
      free(held.map((e) => e.image));
      held = [];
    },
  };
}
