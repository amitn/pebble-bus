# Contributing

Thanks for helping out! Bug reports, new cities that misbehave, and pull
requests are all welcome.

## Reporting a problem

Open an issue with:

- where you were and where you were going (a nearby landmark is enough),
- what the watch showed and what you expected,
- phone logs if you have them (`pebble logs --phone <phone-ip>` shows the
  PKJS side, including the Transitous and TfL requests).

## Development setup

```sh
uv tool install --python 3.13 pebble-tool
pebble sdk install latest   # needs Node.js on the PATH
pebble build
pebble install --emulator emery
pebble emu-app-config --emulator emery   # settings page
```

GPS doesn't work in the emulator, so set a fixed starting point in the
settings when testing there.

## Code notes

- **Watch (C, `src/c/`)**: emery only for now (200×228, 64 colors). Keep heap
  use in mind: the map buffer is fixed at 16 KB and the app has about 114 KB
  free. Hebrew strings arrive already in visual order. Use `draw_name()` for
  any text that may be right-to-left.
- **Phone (JS, `src/pkjs/`)**: the SDK bundles this with webpack 1, so write
  ES5 (`var`, no arrow functions, no template strings, no `const`/`let`).
- Match the style of the surrounding code: two-space indent, short comments
  that explain *why*.
- Test both an RTL city (e.g. Tel Aviv) and London before sending changes to
  text layout or departures.

## Data sources

Please keep to each service's terms:

- **Transitous**: send the User-Agent from `src/pkjs/http.js`, keep the
  attribution in the settings page, and don't add request patterns that poll
  more often than the current 2-minute refresh.
- **TfL**: keep "Powered by TfL Open Data" in the settings page.
- **OpenFreeMap / OpenStreetMap**: keep the street cache, so the same stop
  doesn't refetch tiles, and the OpenStreetMap credit.

## Pull requests

CI builds every pull request. The `.pbw` is attached to the run as an
artifact, so reviewers can install it without building. Screenshots of
UI changes (`pebble screenshot --emulator emery`) help a lot.

By contributing you agree that your contributions are licensed under the
MIT License in [LICENSE](LICENSE).
