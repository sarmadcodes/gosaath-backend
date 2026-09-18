import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./tests/setup/global.ts"],
    env: {
      NODE_ENV: "test",
      /**
       * A separate database, always.
       *
       * The suite creates and deletes documents to prove unique indexes
       * actually reject duplicates. Pointed at the working database that is
       * merely untidy; pointed at production it is destructive. Overriding the
       * name here means no run can touch real data even if .env says otherwise.
       */
      MONGODB_DB: "gosaath_test",
      LOG_LEVEL: "silent",
    },
    // Database tests share one database, so parallel files would race on the
    // same collections. Cheap to serialise at this size.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
