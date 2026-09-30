/**
 * Whether a live stack is there to test against.
 *
 * The suites that talk to anvil and a Rust node run only when `scripts/sdk-e2e.sh` (or a person
 * with a stack already up) says so, by setting `INTERLUDE_APP` or `INTERLUDE_E2E=1`. Without
 * that they are skipped rather than failed, so `pnpm test` on a fresh clone runs the unit
 * tests and passes, instead of failing on a connection refused to a chain nobody started.
 */
export const LIVE = process.env.INTERLUDE_E2E === "1" || Boolean(process.env.INTERLUDE_APP);
