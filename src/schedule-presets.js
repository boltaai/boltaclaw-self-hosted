/**
 * Schedule presets — friendly names mapped to backend schedule format.
 *
 * The backend's normalize_schedule() accepts both { cron: "..." } and
 * { frequency: "...", days: [...], time: "..." } formats.
 */

export const SCHEDULE_PRESETS = {
  daily: {
    label: 'Daily at 9am',
    schedule: { frequency: 'daily', time: '09:00' },
  },
  'weekday-mornings': {
    label: 'Weekdays at 9am',
    schedule: { cron: '0 9 * * 1-5' },
  },
  'twice-daily': {
    label: 'Twice daily (9am & 3pm)',
    schedule: { cron: '0 9,15 * * *' },
  },
  weekly: {
    label: 'Weekly on Monday at 9am',
    schedule: { frequency: 'weekly', days: ['monday'], time: '09:00' },
  },
  '3x-week': {
    label: 'Mon / Wed / Fri at 9am',
    schedule: { frequency: '3x_week', days: ['monday', 'wednesday', 'friday'], time: '09:00' },
  },
};

/**
 * Resolve a schedule string to a backend schedule object.
 * Accepts preset names ("daily", "weekly") or raw cron ("0 9 * * *").
 *
 * @param {string} input - Preset name or cron expression
 * @returns {{ schedule: object, label: string }}
 */
export function resolveSchedule(input) {
  const preset = SCHEDULE_PRESETS[input];
  if (preset) {
    return { schedule: preset.schedule, label: preset.label };
  }

  // Treat as raw cron expression
  return { schedule: { cron: input }, label: `cron: ${input}` };
}
