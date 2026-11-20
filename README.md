# Tab: public demo site

This branch is the GitHub Pages site for [Tab](https://github.com/saintparish4/tab).
The app's code is on `main`; nothing here is used by the app.

The page runs the Tab build twice, in two phone frames, against a relay and two
wallet services that are simulated inside the page. No server, account, wallet
or money is involved. The page itself says what is real and what is simulated.

| Path                | What it is                                                              |
| ------------------- | ----------------------------------------------------------------------- |
| `index.html`        | the demo page                                                           |
| `demo.js`           | built from `src/driver.js` and `src/hub.js`                             |
| `app/`              | `vite build` of `main`, unchanged, plus one added line in `index.html`  |
| `app/sim-socket.js` | that line's script: hands the app's WebSockets to the simulated relay   |
| `src/hub.js`        | the simulated relay, wallet services and payment ledger                 |
| `src/driver.js`     | the page: phone frames, the relay list, and the self-playing walkthrough |
| `src/build.sh`      | rebuilds this site from a checkout of `main`                            |

Rebuild after the app changes (needs `pnpm install` done in the checkout, and
`node_modules` linked or installed beside `src/`):

```bash
APP=/path/to/tab OUT=/path/to/site src/build.sh
```

The simulation's limits: the relay lives in one browser tab, so both phones
must be on the same page; invoices carry an all-zero signature and no
Lightning node would pay them; the wallet rules copy what was measured on
Alby Hub 1.24.7 but are not Alby Hub.
