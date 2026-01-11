import type { Config } from "../config.js";
import { readHeaderValue } from "./utils.js";

function extractServiceKey(headers: Record<string, string | string[] | undefined>) {
  const direct =
    readHeaderValue(headers["x-openapi-key"]) ??
    readHeaderValue(headers["x-api-key"]) ??
    readHeaderValue(headers["x-service-key"]);
  if (direct) return direct;

  const auth = readHeaderValue(headers.authorization);
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }

  return undefined;
}

export function createServiceKeyGuard(config: Config) {
  return async (request: any, reply: any) => {
    if (!config.openapiSharedKey) {
      reply.code(503).send({ error: "service_unavailable" });
      return;
    }

    const key = extractServiceKey(request.headers as Record<string, string | string[] | undefined>);
    if (!key || key !== config.openapiSharedKey) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }
  };
}
