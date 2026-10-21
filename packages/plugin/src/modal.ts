// An open overlay owns the page: the rest goes inert until the undo, which spares an overlay
// beneath (inert already) and a closed one (so it can open on top), then refocuses the opener.
export function takeOver(overlay: HTMLElement, fallback?: () => HTMLElement | null): () => void {
  const opener = overlay.ownerDocument?.activeElement as HTMLElement | null | undefined;
  const beside = [...(overlay.parentElement?.children ?? [])].filter(
    (el) => el !== overlay && !(el as HTMLElement).inert && !(el as HTMLElement).hidden,
  ) as HTMLElement[];
  for (const el of beside) el.inert = true;
  return () => {
    for (const el of beside) el.inert = false;
    const back =
      opener?.isConnected && opener !== opener.ownerDocument.body && opener.getClientRects().length
        ? opener
        : fallback?.();
    back?.focus({ preventScroll: true });
  };
}
