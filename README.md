# Snapora

Snapora is a phone-first event photo booth with a static homepage and capture flow. Open `index.html` to start; the primary action leads to `capture.html`.

## Run locally

Serve the repository root from `localhost` or HTTPS. Camera and microphone access require a secure browser context, and Snapora requests them only after the visitor chooses **Allow camera**.

## Capture storage

Photos and videos stay in the current browser, in IndexedDB, until they are downloaded or deleted. The browser-local device identifier and the limits of 10 photos and 3 videos persist across visits in that browser. Clearing site data resets the local captures and identifier. The current static app does not connect captures to a server or a distinct event, so event-specific quotas and shared galleries require a future backend integration.

There is no package manifest or configured build/lint script in this repository.



hiii
