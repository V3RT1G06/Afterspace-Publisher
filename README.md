# Afterspace Publisher

This repository hosts the authenticated Afterspace HTML publisher and the Windows build pipeline.

An authorized Firebase user uploads an Afterspace HTML file on the GitHub Pages site. The publisher compresses and chunks the HTML into Realtime Database, publishes the live update record, and writes a build request. This avoids a dependency on Firebase Storage. GitHub Actions checks that queue every five minutes, reconstructs and validates the uploaded file, builds the portable Windows app, and creates a release containing only `Afterspace.exe`.

The Afterspace desktop app checks this repository's latest release, verifies GitHub's SHA-256 asset digest and the EXE metadata, then uses a detached rollback helper to replace and restart itself.
