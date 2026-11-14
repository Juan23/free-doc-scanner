import type { SkImage } from '@shopify/react-native-skia';
import { useCallback, useEffect, useState } from 'react';

import { strengthPreview, type Filter } from './clean';
import { disposeNextFrame, liveImages } from './liveImages';
import { previewSession } from './previewSession';

/**
 * The page at the strength under the finger, shown until the stored page replaces it (the order is
 * previewSession's). While `warmAt` is set (the slider is open), a fresh run is warmed up whenever
 * none is going, so the next drag does not wait for the photo to be read and measured again.
 */
export function useStrengthPreview(page: string | undefined, width: number, subjectKey: string, warmAt: Filter | null) {
  // `upTo` is the number of the last image handed over when `image` was set; see liveImages.
  const [shown, setShown] = useState<{ image: SkImage | null; upTo: number }>({ image: null, upTo: 0 });
  const [finishing, setFinishing] = useState(false);
  const [images] = useState(() => liveImages<SkImage>(disposeNextFrame));
  const [session] = useState(() =>
    previewSession({ clear: () => setShown({ image: null, upTo: images.lastNumber() }), finishing: setFinishing }),
  );
  const start = useCallback(
    () => strengthPreview(page!, width, (image) => setShown({ image, upTo: image ? images.add(image) : images.lastNumber() })),
    [page, width, images],
  );
  const preview = (filter: Filter | null) => (filter && page ? session.preview(filter, start) : session.hide());
  useEffect(() => {
    images.release(shown.upTo, shown.image);
  }, [shown, images]);
  useEffect(
    () => () => {
      session.leave();
      images.clear();
    },
    [session, images],
  );
  useEffect(() => () => session.subjectChanged(), [subjectKey, session]);
  // After every render: a store, a turn or a hide has ended the last run; warm the next one while the
  // slider is open (warm does nothing while a run is going).
  useEffect(() => {
    if (warmAt && page) session.warm(warmAt, start);
  });
  return {
    image: shown.image,
    finishing,
    preview,
    hide: session.hide,
    store: session.store,
    pageLoaded: session.pageLoaded,
  };
}
