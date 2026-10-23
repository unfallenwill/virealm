import { createServer, type Server } from "node:http";

export interface ProbeServer {
  readonly url: string;
  close(): Promise<void>;
}

/**
 * Loopback endpoint used only to observe the Accept-Language header Chrome
 * actually sends. It binds to 127.0.0.1 on an ephemeral port and answers one
 * JSON field; no request data is stored.
 */
export async function startProbeServer(): Promise<ProbeServer> {
  const server = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    if (request.method !== "GET" || request.url !== "/accept-language") {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    const header = request.headers["accept-language"];
    response.statusCode = 200;
    response.end(
      JSON.stringify({
        acceptLanguage: Array.isArray(header)
          ? header.join(", ")
          : (header ?? ""),
      }),
    );
  });

  await listen(server);
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("probe server did not bind a TCP port");
  }
  return {
    url: `http://127.0.0.1:${String(address.port)}/accept-language`,
    close: () => closeServer(server),
  };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
    server.closeAllConnections();
  });
}
