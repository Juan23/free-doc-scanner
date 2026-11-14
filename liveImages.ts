/**
 * The preview images handed to the screen, freed only once they can no longer be drawn. Two can be
 * handed over before one render, so each gets a number; `release` frees the ones up to the number
 * a render showed, except the one it shows, and never a later one that render had not seen.
 */
export function liveImages<T extends { dispose: () => void }>() {
  let held: { image: T; n: number }[] = [];
  let handed = 0;
  return {
    /** Holds `image` and returns its number. */
    add(image: T): number {
      held.push({ image, n: ++handed });
      return handed;
    },
    /** The number of the last image handed over. */
    last: () => handed,
    release(upTo: number, onScreen: T | null) {
      const freed = held.filter((e) => e.n <= upTo && e.image !== onScreen);
      held = held.filter((e) => !freed.includes(e));
      freed.forEach((e) => e.image.dispose());
    },
    clear() {
      held.forEach((e) => e.image.dispose());
      held = [];
    },
  };
}
