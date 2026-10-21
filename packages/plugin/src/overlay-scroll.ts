// Beekeeper draws classic scrollbars, whose gutter nothing in a pane can cross, so a band or an
// open row stopped short of the edge. The native bar is hidden and this thumb floats over the
// content instead; wheel, trackpad and keyboard scrolling stay the browser's own.

const INSET = 2;
const MIN_THUMB = 24;

export interface ThumbBox {
  size: number;
  at: number;
  // Content pixels per thumb pixel, for a drag.
  ratio: number;
}

export function thumbBox(
  view: number,
  content: number,
  top: number,
  track: number,
): ThumbBox | null {
  if (content <= view + 1 || track <= 0) return null;
  const size = Math.min(track, Math.max(MIN_THUMB, (view / content) * track));
  const room = track - size;
  const range = content - view;
  const at = room > 0 ? Math.min(room, Math.max(0, (top / range) * room)) : 0;
  return { size, at, ratio: room > 0 ? range / room : 0 };
}

// `rail` is an empty, zero-height element placed right above `body`; the thumb hangs from it.
export function overlayScroll(body: HTMLElement, rail: HTMLElement): () => void {
  const thumb = document.createElement("div");
  thumb.className = "ov-thumb";
  thumb.hidden = true;
  rail.append(thumb);
  let box: ThumbBox | null = null;
  const place = () => {
    box = thumbBox(
      body.clientHeight,
      body.scrollHeight,
      body.scrollTop,
      body.clientHeight - 2 * INSET,
    );
    thumb.hidden = !box;
    if (!box) return;
    thumb.style.height = `${box.size}px`;
    thumb.style.transform = `translateY(${INSET + box.at}px)`;
  };
  body.addEventListener("scroll", place, { passive: true });
  body.addEventListener("pointerenter", place);
  const resize = new ResizeObserver(place);
  resize.observe(body);
  // Rendering, folding a day or switching tabs changes the content's height, not the pane's.
  const mutation = new MutationObserver(place);
  mutation.observe(body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "hidden"],
  });
  thumb.addEventListener("pointerdown", (e) => {
    if (!box) return;
    e.preventDefault();
    const y0 = e.clientY;
    const top0 = body.scrollTop;
    const ratio = box.ratio;
    thumb.setPointerCapture(e.pointerId);
    rail.classList.add("dragging");
    const move = (m: PointerEvent) => {
      body.scrollTop = top0 + (m.clientY - y0) * ratio;
    };
    const up = () => {
      rail.classList.remove("dragging");
      thumb.removeEventListener("pointermove", move);
      thumb.removeEventListener("pointerup", up);
      thumb.removeEventListener("pointercancel", up);
    };
    thumb.addEventListener("pointermove", move);
    thumb.addEventListener("pointerup", up);
    thumb.addEventListener("pointercancel", up);
  });
  place();
  return () => {
    resize.disconnect();
    mutation.disconnect();
    thumb.remove();
  };
}
