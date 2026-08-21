// V1.8.6.9 — human-controlled semantic app version, bumped once per
// round by the person/process doing the work — deliberately separate
// from the git commit SHA (see src/generated/buildMetadata.js), which
// changes every commit and is captured automatically at build time.
// This file is NOT generated and NOT build-time injected; it is edited
// by hand, same as every other "V1.8.6.x" marker already used throughout
// this project's commit messages and docs.

export const APP_VERSION = 'V1.8.6.9';

// Bumped only when the SHAPE of a public/admin JSON response this
// project exposes changes in a way a consumer (Shared Feed, /version,
// /admin/deployment-status) would need to know about — not on every
// feature round. Currently unchanged since it was first introduced.
export const SCHEMA_VERSION = 1;
