import { useEffect, useId, useRef, useState } from "react";
import type { Translate } from "./Workflows";

type PhoneApp = { name: string; package: string };

export default function PhoneAppPicker({ apps, selected, disabled, readOnly, onSelect, t }: {
  apps?: PhoneApp[];
  selected?: PhoneApp;
  disabled: boolean;
  readOnly: boolean;
  onSelect: (value: string) => void;
  t: Translate;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const expanded = open && !disabled && !readOnly;
  const terms = query.normalize("NFKC").toLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches = (apps ?? []).filter((app) => {
    const label = `${app.name} ${app.package}`.normalize("NFKC").toLowerCase();
    return terms.every((term) => label.includes(term));
  });

  useEffect(() => {
    if (expanded && active >= 0) list.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [expanded, active]);

  function close() {
    setOpen(false);
    setActive(-1);
    setQuery("");
  }

  function choose(app: PhoneApp) {
    onSelect(app.package);
    close();
  }

  return <div className="field phone-app-field">
    <label htmlFor={id}>{t("choosePhoneApp")}</label>
    <div className="phone-app-combobox">
      <input id={id} ref={input} role="combobox" type="text" autoComplete="off"
        aria-autocomplete="list" aria-expanded={expanded} aria-controls={expanded ? `${id}-list` : undefined}
        aria-activedescendant={expanded && matches[active] ? `${id}-option-${active}` : undefined}
        placeholder={t("searchPhoneAppsHint")} disabled={disabled} readOnly={readOnly}
        value={expanded ? query : selected?.name || selected?.package || ""}
        onFocus={() => { if (!readOnly) setOpen(true); }}
        onClick={() => { if (!readOnly) setOpen(true); }}
        onBlur={close}
        onChange={(event) => {
          setOpen(true);
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (readOnly || event.nativeEvent.isComposing) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
            const step = event.key === "ArrowDown" ? 1 : -1;
            if (matches.length) setActive(active < 0 ? (step > 0 ? 0 : matches.length - 1)
              : (active + step + matches.length) % matches.length);
          } else if (event.key === "Enter" && expanded && matches[active]) {
            event.preventDefault();
            choose(matches[active]);
          } else if (event.key === "Escape" && expanded) {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }} />
      {!readOnly && <button type="button" className="icon-button phone-app-toggle" tabIndex={-1}
        aria-label={t("choosePhoneApp")} disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (expanded) close();
          else { input.current?.focus(); setOpen(true); }
        }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></button>}
      {expanded && <div className="phone-app-results">
        <ul id={`${id}-list`} ref={list} role="listbox" aria-label={t("choosePhoneApp")}>
          {matches.map((app, index) => <li id={`${id}-option-${index}`} key={app.package} role="option"
            aria-selected={app.package === selected?.package} className={active === index ? "active" : undefined}
            onMouseDown={(event) => event.preventDefault()} onClick={() => choose(app)}>
            <span>{app.name || app.package}</span>{app.name && <small>{app.package}</small>}
          </li>)}
        </ul>
        {!matches.length && <p role="status">{t(apps?.length ? "noMatchingPhoneApps" : "noPhoneApps")}</p>}
      </div>}
    </div>
  </div>;
}
