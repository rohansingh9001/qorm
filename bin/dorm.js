#!/usr/bin/env node
// Launcher for the dorm CLI. Node ≥ 22.6 strips TypeScript types natively,
// so we import the TS entry point directly — no build step.
const { main } = await import(new URL("../src/cli.ts", import.meta.url));
await main();
