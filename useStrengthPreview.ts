import type { SkImage } from '@shopify/react-native-skia';
import { useEffect, useRef, useState } from 'react';

import { strengthPreview, type Filter } from './clean';
import { liveImages } from './liveImages';

/**
 * Frees `images` a frame later: a Canvas hands its new drawing to Skia a moment after React commits,
 * and Skia replays the old one first, so an image just taken off the screen may still be drawn once.
 */
export function disposeNextFrame(images: SkImage[]) {
  if (images.length) requestAnimationFrame(() => images.forEach((image) => image.dispose()));
}

/**
 * The page at the strength under the finger, shown until the stored page replaces it. `finishing`
 * is true between a lift and the start of its store, while the preview catches up to the stored
 * strength. While `warmAt` is set (the slider is open), a fresh run is warmed up after each store,
 * so the next drag does not wait for the photo to be read and measured again.
 */
export function useStrengthPreview(page: string | undefined, width: number, subjectKey: string, warmAt: Filter | null) {
  // The image on screen, and the number of the last image handed over when it was set.
  const [shown, setShown] = useState<{ image: SkImage | null; upTo: number }>({ image: null, upTo: 0 });
  const [finishing, setFinishing] = useState(false);
  const run = useRef<ReturnType<typeof strengthPreview> | null>(null);
  // The run catching up to a lift's strength; hiding stops it too, so nothing shows after a close.
  const finishingRun = useRef<ReturnType<typeof strengthPreview> | null>(null);
  const storing = useRef(false);
  // In the editor the preview stays after a store until the pager has loaded the stored page.
  const awaitingPage = useRef(false);
  const [images] = useState(() => liveImages<SkImage>());
  const start = () => strengthPreview(page!, width, (image) => setShown({ image, upTo: images.add(image) }));
  const clear = () => setShown({ image: null, upTo: images.lastNumber() });
  const hide = () => {
    awaitingPage.current = false;
    finishingRun.current?.stop();
    finishingRun.current = null;
    run.current?.stop();
    run.current = null;
    clear();
  };
  const preview = (filter: Filter | null) => {
    if (!filter || !page) return hide();
    run.current ??= start();
    run.current.preview(filter);
  };
  // The preview's photo is freed before the store, which needs about 100 MB of its own. Slider events
  // can still arrive while the preview catches up after the lift; only the lift's own value is stored.
  const storeAfterPreview = async (filter: Filter, apply: (filter: Filter) => void, options?: { untilPageLoads: boolean }) => {
    if (storing.current) return;
    storing.current = true;
    const current = run.current;
    run.current = null;
    finishingRun.current = current;
    try {
      if (current) {
        setFinishing(true);
        await current.finish(filter);
      }
      const stillShown = current !== null && finishingRun.current === current;
      finishingRun.current = null;
      awaitingPage.current = !!options?.untilPageLoads && stillShown;
      apply(filter);
    } finally {
      setFinishing(false);
      storing.current = false;
    }
  };
  const pageLoaded = () => {
    if (!awaitingPage.current) return;
    awaitingPage.current = false;
    clear();
  };
  useEffect(() => {
    requestAnimationFrame(() => images.release(shown.upTo, shown.image));
  }, [shown, images]);
  useEffect(
    () => () => {
      requestAnimationFrame(images.clear);
    },
    [images],
  );
  // Another page or closing ends it; so does a stored filter (filterPages reloads its pages even when
  // one fails), except in the editor, where pageLoaded clears it once the pager shows the stored page.
  useEffect(
    () => () => {
      if (!awaitingPage.current) hide();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hide reads only refs, setters and `images`, which never changes
    [subjectKey],
  );
  useEffect(() => {
    if (!warmAt || !page || run.current) return;
    run.current = start();
    run.current.warm(warmAt);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- start reads `page` and `width`, read here through the deps that change them
  }, [subjectKey, warmAt]);
  return { image: shown.image, finishing, preview, hide, storeAfterPreview, pageLoaded };
}
