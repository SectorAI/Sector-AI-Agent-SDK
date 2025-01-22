import { CacheManager, DbCacheAdapter, ModelProviderName } from "@elizaos/core";
import { env as config, env } from "../config/index.js";
import { Character } from "../interfaces/character.js";
import { fileURLToPath } from "url";
import path, { dirname } from "path";
import { SqliteDatabaseAdapter } from "@ai16z/adapter-sqlite";
import Database from "better-sqlite3";
import { AgentRuntime } from "./core/runtime.js";

export const parseCharacterFromEnv = (env: NodeJS.ProcessEnv): Character => {
  const CHARACTER = env.CHARACTER;
  const TWITTER_USERNAME = env.TWITTER_USERNAME;
  const TWITTER_ACCESS_TOKEN = env.TWITTER_ACCESS_TOKEN;
  const TWITTER_ACCESS_SECRET = env.TWITTER_ACCESS_SECRET;

  const twitterConfig = {
    TWITTER_APP_KEY: config.twitter.consumerKey,
    TWITTER_APP_SECRET: config.twitter.consumerSecret,
    TWITTER_USERNAME,
    TWITTER_ACCESS_TOKEN,
    TWITTER_ACCESS_SECRET,
  };

  try {
    Object.keys(twitterConfig).forEach((key) => {
      if (!twitterConfig[key]) {
        throw new Error(`Missing ${key} in environment variables.`);
      }
    });

    const character: Character = JSON.parse(CHARACTER);
    character.modelProvider = ModelProviderName.OPENAI;

    character.settings = {
      ...character.settings,
      secrets: {
        ...character.settings?.secrets,
        ...twitterConfig,
      },
    };

    return character;
  } catch (error) {
    console.warn("Error parsing character from environment variables:", error);

    throw new Error("Invalid CHARACTER.");
  }
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export async function createRuntime(character: Character) {
  const token = env.openai.apiKey;

  const filePath = path.resolve(path.join(__dirname), "db.sqlite");
  const db: any = new SqliteDatabaseAdapter(new Database(filePath));

  // const db = new PostgresDatabaseAdapter({
  //   connectionString: env.postgres.url,
  // });

  await db.init();
  const cache = new CacheManager(new DbCacheAdapter(db, character.id));
  const runtime = new AgentRuntime({
    databaseAdapter: db,
    token,
    modelProvider: ModelProviderName.OPENAI,
    evaluators: [],
    character,
    plugins: [].filter(Boolean),
    providers: [],
    actions: [],
    services: [],
    managers: [],
    cacheManager: cache,
  });

  return runtime;
}
