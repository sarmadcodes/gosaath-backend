import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./tests/setup/global.ts"],
    // Runs inside each worker, before any test imports src/config/env.
    setupFiles: ["./tests/setup/env.ts"],
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
      /**
       * Storage is local for every test, whatever .env says.
       *
       * The suite reads the developer's .env, so switching MEDIA_PROVIDER to
       * cloudinary there made six upload tests fail: they sign an upload and
       * then PUT the bytes back through `app.inject`, which cannot reach a
       * third party — nor should a test try to. Pinned here so the suite tests
       * the code rather than whatever this machine happens to be configured
       * for, and so it still passes with no credentials at all.
       *
       * The Cloudinary provider is covered directly in tests/unit, with
       * injected configuration and no network.
       */
      MEDIA_PROVIDER: "local",
      UPLOADS_PROVIDER: "local",
      /**
       * Never a real mail provider, whatever .env says.
       *
       * The suite registers dozens of accounts, and each one sends a
       * verification email. Pointed at Resend it tried to deliver to
       * @szabist.edu.pk addresses that do not exist — which failed the run,
       * but the quieter version of that bug is a test suite that quietly
       * emails real people and burns a sending quota every time it runs.
       *
       * The console provider also keeps the code readable, which is how tests
       * that need one get it.
       */
      EMAIL_PROVIDER: "console",
      RESEND_API_KEY: "",
    },
    // Database tests share one database, so parallel files would race on the
    // same collections. Cheap to serialise at this size.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
