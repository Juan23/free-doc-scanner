export type Disposable = { dispose: () => void };

// Wait one frame before disposing because Skia may replay the previous image once after React commits.
export function disposeNextFrame(images: Disposable[]) {
  if (images.length) requestAnimationFrame(() => images.forEach((image) => image.dispose()));
}

// Track handed-over images by sequence number so `release` never frees a newer one not yet rendered.
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
