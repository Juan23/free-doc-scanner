import type { SkImage } from '@shopify/react-native-skia';
import { useCallback, useEffect, useState } from 'react';

import { strengthPreview, type Filter } from './clean';
import { liveImages } from './liveImages';
import { previewSession } from './previewSession';

/**
 * Frees `images` a frame later: a Canvas hands its new drawing to Skia a moment after React commits,
 * and Skia replays the old one first, so an image just taken off the screen may still be drawn once.
 */
export function disposeNextFrame(images: SkImage[]) {
  if (images.length) requestAnimationFrame(() => images.forEach((image) => image.dispose()));
}

/**
 * The page at the strength under the finger, shown until the stored page replaces it (the order is
 * previewSession's). While `warmAt` is set (the slider is open), a fresh run is warmed up after each
 * store, so the next drag does not wait for the photo to be read and measured again.
 */
export function useStrengthPreview(page: string | undefined, width: number, subjectKey: string, warmAt: Filter | null) {
  // `upTo` is the number of the last image handed over when `image` was set; see liveImages.
  const [shown, setShown] = useState<{ image: SkImage | null; upTo: number }>({ image: null, upTo: 0 });
  const [finishing, setFinishing] = useState(false);
  const [images] = useState(() => liveImages<SkImage>());
  const [session] = useState(() =>
    previewSession({ clear: () => setShown({ image: null, upTo: images.lastNumber() }), finishing: setFinishing }),
  );
  const start = useCallback(
    () => strengthPreview(page!, width, (image) => setShown({ image, upTo: images.add(image) })),
    [page, width, images],
  );
  const preview = (filter: Filter | null) => (filter && page ? session.preview(filter, start) : session.hide());
  useEffect(() => {
    requestAnimationFrame(() => images.release(shown.upTo, shown.image));
  }, [shown, images]);
  useEffect(
    () => () => {
      session.leave();
      requestAnimationFrame(images.clear);
    },
    [session, images],
  );
  useEffect(() => () => session.subjectChanged(), [subjectKey, session]);
  // A new subject (a store, a turn) has ended the last run; warm the next one while the slider is open.
  useEffect(() => {
    if (warmAt && page) session.warm(warmAt, start);
  }, [subjectKey, warmAt, page, session, start]);
  return {
    image: shown.image,
    finishing,
    preview,
    hide: session.hide,
    storeAfterPreview: session.store,
    pageLoaded: session.pageLoaded,
  };
}
