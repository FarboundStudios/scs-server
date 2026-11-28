/** Shared validation for authenticated in-game staff and the local operator. */
export function normalizeAnnouncement(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  const text = value.normalize('NFC').trim();
  return text && text.length <= 240 ? text : null;
}

export function announcementSummary({recipients=0,withGameTelemetry}) {
  const total = `Announcement sent to ${recipients} player connection${recipients === 1 ? '' : 's'}.`;
  return Number.isInteger(withGameTelemetry) && recipients > 0
    ? `${total} ${withGameTelemetry} with game telemetry, ${recipients-withGameTelemetry} without.`
    : total;
}
