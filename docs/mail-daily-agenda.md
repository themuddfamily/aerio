# Daily agenda beside Mail

Mail now includes a daily agenda on its right edge, showing events from connected calendars, local calendars and internet calendar subscriptions. All-day events appear first; timed events include local start/end times, location, calendar name and an ongoing indicator. Events that continue from a previous day are included. Local repeating events and their exceptions use the same recurrence engine as Calendar; provider-expanded occurrences are not expanded twice. All-day end dates remain exclusive.

Use the day arrows, date picker and **Today** to browse without leaving Mail. **Refresh agenda** synchronizes connected calendar data and reports the latest sync status. Click an event to open its details in Calendar on that day, with normal editing permissions and recurrence controls. **Open day in Calendar** switches directly to the selected day. The date and ongoing indicator refresh every 30 seconds while the agenda is visible.

Hide the sidebar with its close button and reopen it with the calendar icon in the Mail toolbar. Visibility is remembered for the local profile; events remain in the existing calendar stores. The sidebar uses already synchronized data, so offline viewing works, and future dates beyond a provider's cached synchronization range can be empty until they are fetched. No additional calendar service or credentials are required.

Validation: `npx vitest run src/components/MailAgenda.test.tsx src/views/CalendarView.test.tsx src/App.test.tsx` and `npm run typecheck`.
