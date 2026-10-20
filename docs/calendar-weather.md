# Optional Calendar weather (D14)

Calendar's sidebar has a **Show weather** switch, off by default. Enabling it exposes a manual city/postcode search and location selection. Aerio never requests device geolocation. The panel explains that Open-Meteo receives search terms and selected coordinates before the user opts in, and links the provider's terms and attribution.

Choose a location to see its next seven forecast days: conditions, low/high temperatures and precipitation probability. Dates use the forecast location's time zone. Celsius and Fahrenheit are available in the location settings. The calendar's selected date is highlighted when covered; dates beyond the forecast horizon are explicitly identified.

Forecasts are fetched by the desktop process from fixed HTTPS provider hosts, with an eight-second timeout, a 256 KB response limit, refused redirects and validated response fields. Renderer requests supply structured settings or search text; they cannot supply a URL. All weather IPC operations refuse while Aerio is locked. Opt-in is checked before provider requests, and in-flight replies cannot repopulate a cache after settings change or weather is disabled.

Settings and forecasts persist in `calendar-weather.sqlite` and are included in full profile backup/restore. Forecasts are reused for 30 minutes across restarts, and concurrent forecast requests share one fetch. The visible Calendar refreshes every 30 minutes. On provider errors or offline failures, a cached forecast less than 24 hours old is labeled stale and shown with the error; older data expires. Refresh retries a failed update and otherwise honors the cache. Changing location or units invalidates the cache. Disabling weather removes the location and cached forecast, and stops further weather requests.

The integration uses Open-Meteo's public API under its published terms. No account or API key is required for its free noncommercial service. Commercial deployments must arrange provider access appropriate to their use; this integration currently uses the public endpoints.

Sources retrieved 20 October 2026:

- [Forecast API](https://open-meteo.com/en/docs): daily weather codes, temperature extrema, precipitation probability, seven-day horizon, automatic coordinate time zone and units.
- [Geocoding API](https://open-meteo.com/en/docs/geocoding-api): place search, coordinate results and country/region labels.
- [Open-Meteo terms](https://open-meteo.com/en/terms): service usage and attribution.

Verification: controlled tests cover opt-in, search input and coordinate validation, fixed URLs, mapping, persistent cache and expiry, stale/offline behavior, oversized/malformed replies, settings changes during a request, locked IPC, preload routing and panel interactions. A public London forecast request returned seven dates with `Europe/London` on 20 October 2026. This smoke check used fixed example coordinates, not a user's location.
