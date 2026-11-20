import type { SkImage } from '@shopify/react-native-skia';
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';

import { strengthPreview, type Filter } from './clean';
import { disposeNextFrame, liveImages } from './liveImages';
import { previewSession } from './previewSession';

export function useStrengthPreview(page: string | undefined, width: number, subjectKey: string, warmAt: Filter | null) {
  const [shown, setShown] = useState<{ image: SkImage | null; lastImageNumber: number }>({ image: null, lastImageNumber: 0 });
  const [finishing, setFinishing] = useState(false);
  const [images] = useState(() => liveImages<SkImage>(disposeNextFrame));
  const [session] = useState(() =>
    previewSession({ clear: () => setShown({ image: null, lastImageNumber: images.lastNumber() }), finishing: setFinishing }),
  );
  const start = useCallback(
    () => strengthPreview(page!, width, (image) => setShown({ image, lastImageNumber: image ? images.add(image) : images.lastNumber() })),
    [page, width, images],
  );
  const preview = (filter: Filter | null) => (filter && page ? session.preview(filter, start) : session.hide());
  useEffect(() => {
    images.release(shown.lastImageNumber, shown.image);
  }, [shown, images]);
  useEffect(
    () => () => {
      session.leave();
      images.clear();
    },
    [session, images],
  );
  // Runs synchronously on commit so an immediate page `onLoadEnd` does not beat `subjectChanged`.
  useLayoutEffect(() => () => session.subjectChanged(), [subjectKey, session]);
  // Re-warm after a store, turn or hide ends a run while the slider stays open.
  useEffect(() => {
    if (warmAt && page) session.warm(warmAt, start);
  });
  return { image: shown.image, finishing, preview, session };
}
