// Cypress configuration for this adapter's own end-to-end tests.
//
// Not shipped: `files` in package.json publishes src, README and LICENSE only.
// This exists so the browser half of the adapter is exercised by real Cypress in a
// real browser, rather than against a stub of the `cy` API that would agree with
// whatever I assumed.

import { defineConfig } from 'cypress';
import http from 'node:http';
import fs from 'node:fs';
import { registerSkiplinkTasks } from './src/task.js';

// Two failing BEM siblings, a missing alt and an empty link. The siblings are the
// case that used to collapse into one fingerprint, so it is checked end to end.
const FIXTURE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Fixture</title></head>
<body>
  <h1>Fixture</h1>
  <!-- Normal-size text: large text passes AA at 3:1, so an h1 at these colours
       would not fail and the sibling test would prove nothing. -->
  <p class="hero__title" style="color:#949494;background:#fff;font-size:14px">Ship faster</p>
  <p class="hero__subtitle" style="color:#9a9a9a;background:#fff;font-size:14px">Every pull request</p>
  <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
  <a href="/x"><span></span></a>
  <p>Fine text with plenty of contrast.</p>
</body>
</html>`;

export default defineConfig({
  fixturesFolder: false,
  video: false,
  screenshotOnRunFailure: false,
  e2e: {
    baseUrl: 'http://127.0.0.1:8391',
    supportFile: 'cypress/support/e2e.js',
    specPattern: 'cypress/e2e/**/*.cy.js',
    setupNodeEvents(on, config) {
      registerSkiplinkTasks(on, config);

      // Test-only, registered here rather than in registerSkiplinkTasks: shipping a
      // task that deletes a customer's baseline file would be an unpleasant thing
      // to have in the published package.
      on('task', {
        'skiplink:reset-baseline': (file) => {
          fs.rmSync(file, { force: true });
          return null;
        },
      });

      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(FIXTURE);
      });
      server.listen(8391, '127.0.0.1');
      on('after:run', () => new Promise((r) => server.close(r)));

      return config;
    },
  },
});
