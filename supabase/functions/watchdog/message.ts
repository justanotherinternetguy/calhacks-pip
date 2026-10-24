export interface IncidentRow {
  id: string;
  user_id: string;
  group_id: string;
  level: string;
  summary: string;
  opened_at?: string;
}

export interface Message {
  title: string;
  body: string;
  critical: boolean;
}

/** Push copy for watchdog-opened incidents. Never includes a location. */
export function watchdogMessage(inc: IncidentRow, displayName: string | null | undefined): Message {
  const name = displayName && displayName.trim() ? displayName.trim() : "Your friend";
  switch (inc.level) {
    case "offline":
      return { title: `${name}'s phone went offline`, body: inc.summary || `${name}'s phone stopped checking in.`, critical: true };
    case "battery_dying":
      return { title: `${name}'s phone is about to die`, body: inc.summary || `${name}'s battery is almost empty.`, critical: true };
    default:
      return { title: `${name} might not be okay`, body: inc.summary || "", critical: inc.level === "unlocked" || inc.level === "sos" || inc.level === "snatch" };
  }
}
