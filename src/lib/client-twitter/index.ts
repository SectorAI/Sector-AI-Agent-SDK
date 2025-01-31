import { Client, elizaLogger } from "@elizaos/core";
import { IAgentRuntime } from "../../interfaces/runtime.js";
import { ClientBase } from "./base.js";
import { TwitterConfig, validateTwitterConfig } from "./environment.js";
import { TwitterInteractionClient } from "./interactions.js";
import { TwitterPostClient } from "./post.js";
import { TwitterSearchClient } from "./search.js";

class TwitterManager {
  client: ClientBase;
  post: TwitterPostClient;
  search: TwitterSearchClient;
  interaction: TwitterInteractionClient;
  constructor(runtime: IAgentRuntime, twitterConfig: TwitterConfig) {
    this.client = new ClientBase(runtime, twitterConfig);
    this.post = new TwitterPostClient(this.client, runtime);

    if (twitterConfig.TWITTER_SEARCH_ENABLE) {
      // this searches topics from character file
      elizaLogger.warn("Twitter/X client running in a mode that:");
      elizaLogger.warn("1. violates consent of random users");
      elizaLogger.warn("2. burns your rate limit");
      elizaLogger.warn("3. can get your account banned");
      elizaLogger.warn("use at your own risk");
      this.search = new TwitterSearchClient(this.client, runtime);
    }

    this.interaction = new TwitterInteractionClient(this.client, runtime);
  }
}

export const TwitterClientInterface: Client = {
  async start(runtime: any) {
    const twitterConfig: TwitterConfig = await validateTwitterConfig(runtime);

    elizaLogger.log("Twitter client started");

    const manager = new TwitterManager(runtime, twitterConfig);

    await manager.client.init();

    await manager.post.start();

    if (manager.search) await manager.search.start();

    await manager.interaction.start();

    return manager;
  },
  async stop() {
    elizaLogger.warn("Twitter client does not support stopping yet");
  },
};

export default TwitterClientInterface;
