import { stringToUuid } from "@elizaos/core";
import TwitterClientInterface from "./lib/client-twitter/index.js";
import { createRuntime, parseCharacterFromEnv } from "./lib/utils.js";

async function agent() {
  try {
    const character = parseCharacterFromEnv(process.env);

    character.id ??= stringToUuid(character.name);
    character.ticker ??= character.name;

    const runtime = await createRuntime(character);
    await runtime.initialize();

    await TwitterClientInterface.start(runtime as any);
  } catch (error) {
    console.error("Error starting agent:", error);
    process.exit(1);
  }
}

agent();

process.on("message", (msg) => {
  if (msg === "stop") {
    console.log("Stopping agent...");
    process.exit(0);
  }
});

process.on("message", async (message) => {
  console.log("Message from parent:", message);
});
