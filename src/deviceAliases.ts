export function deviceStorageKey(serial: string, identities: Record<string, string>) {
  return identities[serial] ? `hardware:${identities[serial]}` : serial;
}

export function currentDeviceKey(
  serial: string, current: { hardware?: string | null } | undefined, identities: Record<string, string>,
) {
  if (!current) return deviceStorageKey(serial, identities);
  return current.hardware ? `hardware:${current.hardware}` : undefined;
}

export function legacyDeviceKeys(serial: string, hardware: string, identities: Record<string, string>, keys: string[]) {
  const servicePrefix = `adb-${hardware}-`;
  return [...new Set([serial, hardware, ...keys])].filter((candidate) => {
    if (identities[candidate]) return identities[candidate] === hardware;
    // An unbound network endpoint does not prove ownership of legacy records.
    if (candidate === hardware) return true;
    return candidate.startsWith(servicePrefix)
      && /^[a-zA-Z0-9]{6}\._adb-tls-connect\._tcp$/.test(candidate.slice(servicePrefix.length));
  });
}

export function bindDeviceRecord<T>(
  serial: string, hardware: string, identities: Record<string, string>, records: Record<string, T>,
) {
  records = preserveUnboundRecord(serial, hardware, identities, records);
  const legacy = legacyDeviceKeys(serial, hardware, identities, Object.keys(records))
    .filter((key) => Object.prototype.hasOwnProperty.call(records, key));
  if (!legacy.length) return records;
  const key = `hardware:${hardware}`;
  const next = { ...records, [key]: records[key] ?? records[legacy[0]] };
  for (const candidate of legacy) delete next[candidate];
  return next;
}

export function preserveUnboundRecord<T>(
  serial: string, hardware: string, identities: Record<string, string>, records: Record<string, T>,
) {
  if (identities[serial] || !Object.prototype.hasOwnProperty.call(records, serial) ||
    legacyDeviceKeys(serial, hardware, identities, []).includes(serial)) return records;
  // Keep ambiguous data for recovery while preventing future polls from adopting it.
  const key = `unverified:${serial}`;
  const next = { ...records, [key]: records[key] ?? records[serial] };
  delete next[serial];
  return next;
}

export function verifiedDeviceBinding(
  serial: string, hardware: string, identities: Record<string, string>,
  bind: (serial: string, hardware: string, identities: Record<string, string>) => void,
) {
  const previous = identities[serial];
  // Move any legacy records for a previously identified handset before reusing its endpoint.
  if (previous && previous !== hardware) bind(serial, previous, identities);
  bind(serial, hardware, identities);
  if (previous !== hardware) identities[serial] = hardware;
}
