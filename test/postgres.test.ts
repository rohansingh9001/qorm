/**
 * Postgres conformance — runs the shared suite against a real server
 * (docker: `docker run -d --name dorm-pg -e POSTGRES_USER=dorm -e POSTGRES_PASSWORD=dorm \
 *   -e POSTGRES_DB=dorm -p 5433:5432 postgres`). Skips cleanly when unreachable.
 *
 * Override via DORM_PG_HOST / DORM_PG_PORT / DORM_PG_USER / DORM_PG_PASSWORD / DORM_PG_DB.
 */
import { test } from "node:test";
import { runConformanceSuite } from "./helpers/conformance.ts";
import { createBackend, type DatabaseConfig } from "../src/index.ts";

const config: DatabaseConfig = {
  engine: "postgres",
  name: process.env.DORM_PG_DB ?? "dorm",
  user: process.env.DORM_PG_USER ?? "dorm",
  password: process.env.DORM_PG_PASSWORD ?? "dorm",
  host: process.env.DORM_PG_HOST ?? "127.0.0.1",
  port: Number(process.env.DORM_PG_PORT ?? 5433),
};

async function available(): Promise<boolean> {
  for (let i = 0; i < 5; i++) {
    try {
      const probe = await createBackend(config);
      await probe.execute("SELECT 1");
      await probe.close();
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return false;
}

if (await available()) {
  runConformanceSuite("postgres", config);
} else {
  test("postgres conformance (server not reachable — start the docker container)", { skip: true }, () => {});
}
