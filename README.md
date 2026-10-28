# Leak Log

My flat's ceiling leaks, and roofers haven't been able to find where the water
gets in. Paying for more inspections is expensive and hasn't settled it, so I'm
collecting data instead.

Leak Log is a small phone web app. I use it to record every time I check the
ceiling, whether it was leaking or dry. Each check is then matched against
Met Office weather data for my flat: rainfall, wind speed, wind direction and
gusts. With enough checks, the data should show which conditions cause the
leak. For example, if it only leaks when heavy rain comes with strong
south-westerly gusts, that points at one side of the roof.

## Using it

- Open the app on an Android phone in Chrome, then use **Add to Home screen**.
- Set your postcode once in **Settings** (the cog, top right).
- Tap **+** whenever you find a leak. If you were out when it happened,
  enter the whole time you were away.
- Tap a leak in the history to change it, e.g. to add water you found
  later.
- Open the **Insights** tab to compare the weather during leaks with rainy
  hours that had no leak, so you can see what differs when it rains. It needs
  a few leaks logged before it can compare them.
- You don't log dry spells: any time without a logged leak counts as dry,
  from the day the app was first opened.
- To back up or analyse your data, use **Settings → Export CSV**. It saves
  one row per hour with your leaks and the weather, and works offline.
- To restore a backup (on a new phone, say), use **Settings → Import CSV**.
  It only adds: nothing already on the phone is changed or removed. Set
  your postcode again afterwards, as it isn't stored in exports.

## Privacy and security

- **No API keys.** Weather comes from [Open-Meteo](https://open-meteo.com/),
  which serves the Met Office UKV 2 km model. It doesn't need a key, so there
  is no secret that could leak into this repository.
- **Data stays on the phone.** Leaks and the flat's location are stored in
  the browser on the device. They are not in this repository.
- **Postcode lookup.** When you set the location, the postcode is sent once
  to [postcodes.io](https://postcodes.io/) to find its map position. It
  isn't sent anywhere else.
- **Weather lookups.** To fetch the weather, the flat's coordinates are sent
  to Open-Meteo, rounded to about 1 km so the exact address isn't shared.
  The postcode is never sent there.
- **Exports are personal.** A CSV export contains your leaks and the rounded
  coordinates the weather was fetched for, so keep it private.
- `.gitignore` excludes exported CSVs and any `.env` or secrets files, so they
  can't be committed by accident.

## Roadmap

The app is being built in stages. Each stage adds something usable.

- [x] **Stage 1: Record leaks.** Leaks with a time range, a severity or spill
      volume for each of the two ceiling holes, and notes, stored on the
      phone. Any time without a logged leak counts as dry. Installable and
      works offline.
- [x] **Stage 2: Set location.** A Settings page to set the flat's
      location by UK postcode, looked up once and stored on the phone.
- [x] **Stage 3: Attach weather.** An hour-by-hour record of Met Office
      UKV weather (via Open-Meteo) for the flat, each hour dry unless a
      leak covers it, and a weather summary under each leak.
- [x] **Stage 4: CSV export.** Export leaks and the hourly weather as one
      CSV file from Settings, for backup and analysis.
- [x] **Stage 5: CSV import.** Load a CSV export back into the app, to
      restore a backup on a new phone or after data is cleared.
- [x] **Stage 6: Edit a leak.** Tap a leak in the history to change its
      times, holes or notes.
- [x] **Stage 7: In-app insights.** Charts comparing weather during leaks
      with rainy hours that had no leak.
- [ ] **Stage 8: Analysis notebook (on hold).** A Python (pandas) notebook
      that models which weather factors predict a leak. Waiting until there's
      enough real data to know what the report should say.
- [ ] **Stage 9: Met Office station observations.** A scheduled GitHub
      Action collects hourly Met Office DataHub land observations. The API
      key is kept in GitHub Secrets and is never in the code.
- [ ] **Stage 10: Quality.** Automated tests and CI.
- [ ] **Stage 11: Record absences.** Mark periods away from home, so the
      analysis doesn't count them as dry.

## Tech

Plain HTML, CSS and JavaScript (no build step). It is a Progressive Web App:
a web manifest makes it installable and a service worker lets it open offline.
It is hosted on GitHub Pages.

## Running locally

Any static file server works. For example, with Python installed:

```bash
python -m http.server 8000
```

Then open http://localhost:8000.
