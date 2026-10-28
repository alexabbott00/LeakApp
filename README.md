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
- Tap **+** whenever you find a leak. If you were out when it happened,
  enter the whole time you were away.
- You don't log dry spells: any time without a logged leak counts as dry,
  from the day the app was first opened.

## Privacy and security

- **No API keys.** Weather comes from [Open-Meteo](https://open-meteo.com/),
  which serves the Met Office UKV 2 km model. It doesn't need a key, so there
  is no secret that could leak into this repository.
- **Data stays on the phone.** Leaks and the flat's location are stored in
  the browser on the device. They are not in this repository.
- `.gitignore` excludes exported CSVs and any `.env` or secrets files, so they
  can't be committed by accident.

## Roadmap

The app is being built in stages. Each stage adds something usable.

- [x] **Stage 1: Record leaks.** Leaks with a time range, severity or spill
      volume, and notes, stored on the phone. Any time
      without a logged leak counts as dry. Installable and works offline.
- [ ] **Stage 2: Attach weather.** Fetch Met Office UKV hourly weather
      (via Open-Meteo) for the hours before each check: rain totals, mean
      wind, max gust and wind direction.
- [ ] **Stage 3: In-app insights.** Charts comparing weather on leak checks
      with weather on dry checks, plus CSV import to restore a backup.

- [ ] **Stage 4: Analysis notebook.** A Python (pandas) notebook that models
      which weather factors predict a leak.
- [ ] **Stage 5: Met Office station observations.** A scheduled GitHub
      Action collects hourly Met Office DataHub land observations. The API
      key is kept in GitHub Secrets and is never in the code.
- [ ] **Stage 6 Quality.** Automated tests and CI.
- [ ] **Stage 7: Record absences.** Mark periods away from home, so the
      analysis doesn't count them as dry.
- [ ] CSV export

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
