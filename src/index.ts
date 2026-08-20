import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { logEvent } from "./log.js";

const config = loadConfig();
const server = await createApp(config);
server.listen(config.port, config.host, () => {
  logEvent({
    action: "listen",
    outcome: "READY",
    host: config.host,
    port: config.port,
    public_base_url: config.publicBaseUrl,
  });
});
