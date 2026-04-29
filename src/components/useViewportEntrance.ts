import { useEffect, useState } from "react";

export function useViewportEntrance(
  isInViewport: boolean,
  isMediaReady: boolean,
  isTransforming: boolean
) {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (!isInViewport) {
      setIsVisible(false);
      return;
    }

    if (isTransforming) {
      setIsVisible(true);
      return;
    }

    if (!isMediaReady) {
      setIsVisible(false);
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      setIsVisible(true);
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [isInViewport, isMediaReady, isTransforming]);

  return isVisible;
}
