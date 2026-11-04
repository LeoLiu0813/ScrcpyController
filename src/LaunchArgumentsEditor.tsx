import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Message } from "./locales";
import { optionName, optionNote } from "./engineOptionNotes";

type Translate = (key: Message) => string;
type EngineOptions = { version: string; options: { syntax: string; description: string }[] };

function EngineOptionReference({ t }: { t: Translate }) {
  const [reference, setReference] = useState<EngineOptions>();
  const [error, setError] = useState(false);
  const [search, setSearch] = useState("");
  useEffect(() => {
    let active = true;
    let revision = 0;
    const refresh = async () => {
      const request = ++revision;
      setError(false);
      try {
        const next = await invoke<EngineOptions>("engine_options");
        if (active && request === revision) setReference(next);
      } catch {
        if (active && request === revision) {
          setReference(undefined);
          setError(true);
        }
      }
    };
    const unlisten = listen("engine-options-changed", () => { if (active) void refresh(); });
    void refresh();
    return () => {
      active = false;
      void unlisten.then((stop) => stop()).catch(() => {});
    };
  }, []);

  const query = search.trim().toLowerCase();
  const options = reference?.options.map((option) => ({ ...option, note: optionNote(optionName(option.syntax)) }))
    .filter(({ syntax, description, note }) => !query
      || `${syntax} ${note ?? ""} ${description}`.toLowerCase().includes(query));
  return <section className="engine-option-reference">
    <div className="settings-card-heading">
      <h3>{t("engineOptionReference")}</h3>
      {reference && <small>{reference.version} · {reference.options.length}</small>}
    </div>
    {!reference ? <small role={error ? "alert" : "status"}>{t(error ? "queryFailed" : "loadingEngineOptions")}</small> : <>
      <input type="search" aria-label={t("searchEngineOptions")} placeholder={t("searchEngineOptions")}
        value={search} onChange={(event) => setSearch(event.target.value)} />
      {options?.length ? <dl className="engine-option-list">
        {options.map(({ syntax, description, note }) => <div key={syntax}>
          <dt><code>{syntax}</code></dt>
          <dd><span lang="zh-CN">{note ?? t("engineOptionUnknown")}</span>
            {description && <details>
              <summary>{t("engineOptionOriginal")}</summary>
              <p lang="en">{description}</p>
            </details>}
          </dd>
        </div>)}
      </dl> : <small role="status">{t("noEngineOptions")}</small>}
    </>}
  </section>;
}

export default function LaunchArgumentsEditor({ args, update, preview, inspect, t }: {
  args: string[]; update: (args: string[]) => void; preview?: string[]; inspect: (args: string[]) => void; t: Translate;
}) {
  const stored = args.join("\n");
  const [draft, setDraft] = useState(stored);
  useEffect(() => setDraft(stored), [stored]);
  const draftArgs = () => draft.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return <section className="device-settings-section device-launch-editor">
    <div className="settings-card-heading"><h2>{t("launchPreview")}</h2>
      <button type="button" data-tip={t("previewHint")} onClick={() => inspect(draftArgs())}>{t("previewArgs")}</button>
    </div>
    <label className="field" data-tip={t("extraLaunchArgsHint")}>
      <span>{t("extraLaunchArgs")}</span>
      <textarea rows={7} spellCheck={false} value={draft} placeholder="--max-fps=60"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const values = draftArgs();
          setDraft(values.join("\n"));
          if (values.join("\n") !== stored) update(values);
        }} />
    </label>
    {preview && <div className="settings-stack">
      <h3>{t("effectiveLaunchArgs")}</h3>
      <pre className="settings-preview">{preview.map((arg) => JSON.stringify(arg)).join("\n")}</pre>
    </div>}
    <EngineOptionReference t={t} />
  </section>;
}
