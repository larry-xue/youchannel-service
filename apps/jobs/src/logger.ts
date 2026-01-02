import pino from "pino";
import type { Config } from "./config.js";

export function buildLogger(config: Config) {
  if (config.nodeEnv === "development") {
    return pino({ level: config.logLevel }, pino.transport({
      target: "pino-pretty",
      options: { colorize: true }
    }));
  }

  return pino({ level: config.logLevel });
}
