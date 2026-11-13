import { useEffect } from "react";
import { useLocation } from "react-router-dom";

export default function usePageNavigation(contentReady) {
  const { pathname, hash, key } = useLocation();
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      let id = hash.slice(1);
      try { id = decodeURIComponent(id); } catch { /* Leave malformed fragments alone. */ }
      const target = id ? document.getElementById(id) : document.getElementById("main");
      if (target) {
        if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
        target.focus({ preventScroll: true });
        if (id) target.scrollIntoView();
      }
      if (!id) window.scrollTo(0, 0);
    });
    return () => cancelAnimationFrame(frame);
  }, [pathname, hash, key, contentReady]);
}
