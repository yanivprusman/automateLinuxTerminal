import { useEffect, useState } from "react";
import { MARQUEE_STEP_MS } from "./menu.js";

/** The clock behind a scrolling sign: a counter that advances one cell per step while
 *  `active`, and sits at 0 otherwise.
 *
 *  Inactive costs nothing — no timer, no state change, so a topic that fits its row never
 *  makes this app redraw. That matters here: every re-render of the menu or the topic bar
 *  repaints a frame over a live terminal, so the sign only runs when there is genuinely
 *  something out of view.
 *
 *  `resetKey` restarts the pass. A new topic must begin at its first character rather than
 *  inheriting the phase of the one it replaced. */
export function useMarqueeTick(active: boolean, resetKey: string = ""): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    setTick(0);
    if (!active) return;
    const id = setInterval(() => setTick(t => t + 1), MARQUEE_STEP_MS);
    return () => clearInterval(id);
  }, [active, resetKey]);
  return tick;
}
