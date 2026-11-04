export function deviceStorageKey(serial: string, identities: Record<string, string>) {
  return identities[serial] ? `hardware:${identities[serial]}` : serial;
}

export function legacyDeviceKeys(serial: string, hardware: string, identities: Record<string, string>, keys: string[]) {
  const servicePrefix = `adb-${hardware}-`;
  return [...new Set([serial, hardware, ...keys])].filter((candidate) => {
    if (identities[candidate]) return identities[candidate] === hardware;
    if (candidate === serial || candidate === hardware) return true;
    return candidate.startsWith(servicePrefix)
      && /^[a-zA-Z0-9]{6}\._adb-tls-connect\._tcp$/.test(candidate.slice(servicePrefix.length));
  });
}

export function bindAlias(
  serial: string, hardware: string, identities: Record<string, string>, aliases: Record<string, string>, pendingName?: string,
) {
  const key = `hardware:${hardware}`;
  const legacy = legacyDeviceKeys(serial, hardware, identities, Object.keys(aliases));
  const matching = legacy.filter((candidate) => Object.prototype.hasOwnProperty.call(aliases, candidate));
  if (!matching.length && pendingName === undefined) return aliases;
  const next = { ...aliases };
  if (!next[key] && matching.length) next[key] = aliases[matching[0]];
  for (const candidate of matching) delete next[candidate];
  if (pendingName) next[key] = pendingName;
  else if (pendingName === "") delete next[key];
  return next;
}
