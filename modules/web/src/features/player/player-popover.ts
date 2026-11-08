// Keep every control popover above the right control row, including a wrapped mobile bar.
export function positionPlayerPopover(
  panel: HTMLElement,
  trigger: HTMLElement,
  stage: HTMLElement,
  preferredWidth: number,
): void {
  const bounds = stage.getBoundingClientRect();
  const anchor = trigger.getBoundingClientRect();
  const row =
    trigger.closest('.control-end')?.getBoundingClientRect() ?? anchor;
  const parent = panel.offsetParent?.getBoundingClientRect() ?? bounds;
  const width = Math.min(preferredWidth, Math.max(0, bounds.width - 24));
  const left = Math.max(
    bounds.left + 12,
    Math.min(bounds.right - width - 12, anchor.right - width),
  );
  Object.assign(panel.style, {
    width: `${width}px`,
    left: `${left - parent.left}px`,
    bottom: `${parent.bottom - row.top + 8}px`,
    maxHeight: `${Math.max(0, row.top - bounds.top - 20)}px`,
  });
}
