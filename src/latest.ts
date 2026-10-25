/** Returns a guard: call it per request; it reports whether that request is still the newest. */
export function latest() {
  let n = 0;
  return () => {
    const mine = ++n;
    return () => mine === n;
  };
}
