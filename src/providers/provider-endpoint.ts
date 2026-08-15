import { CodeSmithError } from "../shared/errors.js";

export function endpointFor(path: string, baseUrl: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  } catch {
    throw new CodeSmithError("configuration", "The selected provider has an invalid endpoint.");
  }

  if (!["https:", "http:"].includes(endpoint.protocol)) {
    throw new CodeSmithError("configuration", "The selected provider has an invalid endpoint.");
  }
  return endpoint;
}
