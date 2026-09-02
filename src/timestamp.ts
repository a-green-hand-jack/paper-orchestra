/**
 * A compact UTC stamp, `YYYYMMDDHHMMSS`.
 *
 * Derived by stripping every non-digit rather than slicing the ISO string:
 * slicing at a fixed offset lands inside the millisecond fraction and leaves a
 * trailing `.` in run ids and directory names.
 */
export function compactStamp(date: Date = new Date()): string {
  return date.toISOString().replace(/\D/g, "").slice(0, 14);
}
