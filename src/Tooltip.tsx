import { useEffect, useRef } from "react";

export default function Tooltip() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const tip = ref.current;
    if (!tip) return;
    let anchor: Element | null = null;

    function hide() {
      if (tip?.matches(":popover-open")) tip.hidePopover();
      anchor = null;
    }

    function show(event: Event) {
      if (!tip || !(event.target instanceof Element)) return;
      if (event.type === "focusin" && !event.target.matches(":focus-visible")) return;
      const target = event.target.closest("[data-tip]");
      if (target === anchor) return;
      hide();
      const label = target?.getAttribute("data-tip");
      if (!target || !label) return;

      anchor = target;
      tip.textContent = label;
      tip.showPopover();
      const rect = target.getBoundingClientRect();
      const { width, height } = tip.getBoundingClientRect();
      const side = target.closest(".rail, .device-settings-nav") && rect.right + width + 8 <= window.innerWidth;
      const x = side ? rect.right + 6 : rect.right - width;
      const y = side ? rect.top : rect.top >= height + 8 ? rect.top - height - 6 : rect.bottom + 6;
      tip.style.left = `${Math.max(6, Math.min(x, window.innerWidth - width - 6))}px`;
      tip.style.top = `${Math.max(6, Math.min(y, window.innerHeight - height - 6))}px`;
    }

    function leave(event: PointerEvent | FocusEvent) {
      if (anchor?.contains(event.target as Node) && !anchor.contains(event.relatedTarget as Node)) hide();
    }

    document.addEventListener("pointerover", show);
    document.addEventListener("pointerout", leave);
    document.addEventListener("focusin", show);
    document.addEventListener("focusout", leave);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      hide();
      document.removeEventListener("pointerover", show);
      document.removeEventListener("pointerout", leave);
      document.removeEventListener("focusin", show);
      document.removeEventListener("focusout", leave);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, []);

  return <div ref={ref} className="tooltip" popover="manual" role="tooltip" />;
}
