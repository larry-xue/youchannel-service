import * as Sentry from "@sentry/node";
import type { Config } from "./config";

export function initSentry(config: Config) {
  if (!config.sentryDsn) {
    return;
  }

  Sentry.init({
    dsn: config.sentryDsn,
    environment: config.sentryEnv ?? config.nodeEnv,
    tracesSampleRate: 0.1
  });
}

export function captureException(error: unknown) {
  if (!Sentry.getCurrentHub().getClient()) {
    return;
  }

  Sentry.captureException(error);
}
