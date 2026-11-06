import { listen } from "@colyseus/tools";

import app from "./app.config.js";
import { connectDb } from "./db.js";
import { installPlatformBoards } from "./platformBoards.js";
import { installRoomReporter } from "./legion-room-reporter.js";

// Player-progress persistence (src/db.ts) connects before the room accepts
// players; connectDb() itself never throws or hangs (degrades to "no persistence").
await connectDb();

// Listens on PORT (or 2567).
await listen(app);

// Reports this pod's rooms to the Bloxity matchmaker (Open Rooms, friend joins, the menu's
// "players in this server"); a no-op outside a Legion deployment.
installRoomReporter();

// Reports saved scores to Bloxity's trophy boards; a no-op outside a Legion deployment.
installPlatformBoards();
