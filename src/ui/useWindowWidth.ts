import { useEffect, useState } from "react";

/** The window's inner width, live. Only for window-level rules (the ⌘L hint); parts size themselves with a ResizeObserver. */
export function useWindowWidth() {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}
