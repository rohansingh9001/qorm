/**
 * MySQL conformance — runs the shared suite against a real server
 * (docker: `docker run -d --name dorm-mysql -e MYSQL_ROOT_PASSWORD=dorm -e MYSQL_DATABASE=dorm \
 *   -e MYSQL_USER=dorm -e MYSQL_PASSWORD=dorm -p 3307:3306 mysql:8`). Skips cleanly when unreachable.
 *
 * Override via DORM_MYSQL_HOST / DORM_MYSQL_PORT / DORM_MYSQL_USER / DORM_MYSQL_PASSWORD / DORM_MYSQL_DB.
 */
import { test } from "node:test";
import { runConformanceSuite } from "./helpers/conformance.ts";
import { createBackend, type DatabaseConfig } from "../src/index.ts";

const config: DatabaseConfig = {
  engine: "mysql",
  name: process.env.DORM_MYSQL_DB ?? "dorm",
  user: process.env.DORM_MYSQL_USER ?? "dorm",
  password: process.env.DORM_MYSQL_PASSWORD ?? "dorm",
  host: process.env.DORM_MYSQL_HOST ?? "127.0.0.1",
  port: Number(process.env.DORM_MYSQL_PORT ?? 3307),
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
  runConformanceSuite("mysql", config);
} else {
  test(
    "mysql conformance (server not reachable — start the docker container)",
    { skip: true },
    () => {},
  );
}
