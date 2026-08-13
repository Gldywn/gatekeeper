import { animate } from "motion";

// Centralised so motion stays coherent (see DESIGN.md Motion): transform/opacity
// only, and looping helpers reserved for functional "alive/waiting" indicators.

export interface Loop {
  stop: () => void;
}

const NOOP: Loop = { stop: () => {} };

// Exponential ease-out, the hallmark entrance token.
const EASE_OUT = [0.16, 1, 0.3, 1] as const;
const SHORT = 0.22;
const LONG = 0.42;

function reduced(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** One orchestrated moment on mount: a short staggered fade-up of the blocks. */
export function reveal(elements: Element[]): void {
  if (reduced()) {
    return;
  }
  elements.forEach((el, i) => {
    animate(
      el,
      { opacity: [0, 1], y: [8, 0] },
      { duration: LONG, ease: EASE_OUT, delay: Math.min(i * 0.06, 0.5) },
    );
  });
}

/** One-shot entrance for a newly added element (a fresh proposal card). */
export function enter(el: Element): void {
  if (reduced()) {
    return;
  }
  animate(el, { opacity: [0, 1], y: [6, 0] }, { duration: SHORT, ease: EASE_OUT });
}

/** Subtle looping pulse for a live "active" indicator. Functional-loader use only. */
export function pulse(el: Element): Loop {
  if (reduced()) {
    return NOOP;
  }
  const controls = animate(
    el,
    { opacity: [1, 0.5], scale: [1, 1.18] },
    { duration: 1.6, ease: "easeInOut", repeat: Infinity, repeatType: "mirror" },
  );
  return { stop: () => controls.stop() };
}

/** Gentle breathing for a waiting/empty state. Functional-loader use only. */
export function breathe(el: Element): Loop {
  if (reduced()) {
    return NOOP;
  }
  const controls = animate(
    el,
    { opacity: [0.5, 0.85] },
    { duration: 2.2, ease: "easeInOut", repeat: Infinity, repeatType: "mirror" },
  );
  return { stop: () => controls.stop() };
}
