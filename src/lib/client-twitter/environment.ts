import { parseBooleanFromText } from "@elizaos/core";
import { z } from "zod";
import { IAgentRuntime } from "../../interfaces/runtime.js";

export const DEFAULT_MAX_TWEET_LENGTH = 280;

export const twitterEnvSchema = z.object({
  TWITTER_DRY_RUN: z.boolean(),
  TWITTER_USERNAME: z.string().min(1, "Twitter username is required"),
  TWITTER_APP_KEY: z.string(),
  TWITTER_APP_SECRET: z.string(),
  TWITTER_ACCESS_TOKEN: z.string(),
  TWITTER_ACCESS_SECRET: z.string(),
  TWITTER_2FA_SECRET: z.string(),
  MAX_TWEET_LENGTH: z.number().int().default(DEFAULT_MAX_TWEET_LENGTH),
  TWITTER_SEARCH_ENABLE: z.boolean().default(false),
  TWITTER_RETRY_LIMIT: z.number().int(),
  ENABLE_ACTION_PROCESSING: z.boolean(),
  ACTION_INTERVAL: z.number().int(),
  POST_IMMEDIATELY: z.boolean(),
});

export type TwitterConfig = z.infer<typeof twitterEnvSchema>;

function parseTargetUsers(targetUsersStr?: string | null): string[] {
  if (!targetUsersStr?.trim()) {
    return [];
  }

  return targetUsersStr
    .split(",")
    .map((user) => user.trim())
    .filter(Boolean); // Remove empty usernames
  /*
        .filter(user => {
            // Twitter username validation (basic example)
            return user && /^[A-Za-z0-9_]{1,15}$/.test(user);
        });
        */
}

function safeParseInt(
  value: string | undefined | null,
  defaultValue: number
): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : Math.max(1, parsed);
}

// This also is organized to serve as a point of documentation for the client
// most of the inputs from the framework (env/character)

// we also do a lot of typing/parsing here
// so we can do it once and only once per character
export async function validateTwitterConfig(
  runtime: IAgentRuntime
): Promise<TwitterConfig> {
  try {
    const twitterConfig = {
      TWITTER_DRY_RUN: parseBooleanFromText(
        runtime.getSetting("TWITTER_DRY_RUN") ||
          process.env.TWITTER_DRY_RUN ||
          "false"
      ), // parseBooleanFromText return null if "", map "" to false
      TWITTER_USERNAME: runtime.getSetting("TWITTER_USERNAME"),
      TWITTER_APP_KEY: runtime.getSetting("TWITTER_APP_KEY"),
      TWITTER_APP_SECRET: runtime.getSetting("TWITTER_APP_SECRET"),
      TWITTER_ACCESS_TOKEN: runtime.getSetting("TWITTER_ACCESS_TOKEN"),
      TWITTER_ACCESS_SECRET: runtime.getSetting("TWITTER_ACCESS_SECRET"),
      // number as string?
      MAX_TWEET_LENGTH: safeParseInt(
        runtime.getSetting("MAX_TWEET_LENGTH") || process.env.MAX_TWEET_LENGTH,
        DEFAULT_MAX_TWEET_LENGTH
      ),
      // bool
      TWITTER_SEARCH_ENABLE: parseBooleanFromText(
        runtime.getSetting("TWITTER_SEARCH_ENABLE") ||
          process.env.TWITTER_SEARCH_ENABLE ||
          "false"
      ),
      // string passthru
      TWITTER_2FA_SECRET:
        runtime.getSetting("TWITTER_2FA_SECRET") ||
        process.env.TWITTER_2FA_SECRET ||
        "",
      // int
      TWITTER_RETRY_LIMIT: safeParseInt(
        runtime.getSetting("TWITTER_RETRY_LIMIT") ||
          process.env.TWITTER_RETRY_LIMIT,
        5
      ),
      // bool
      ENABLE_ACTION_PROCESSING: parseBooleanFromText(
        runtime.getSetting("ENABLE_ACTION_PROCESSING") ||
          process.env.ENABLE_ACTION_PROCESSING ||
          "true"
      ),
      // int in minutes (min 1m)
      ACTION_INTERVAL: safeParseInt(
        runtime.getSetting("ACTION_INTERVAL") || process.env.ACTION_INTERVAL,
        5
      ), // 5 minutes
      // bool
      POST_IMMEDIATELY: parseBooleanFromText(
        runtime.getSetting("POST_IMMEDIATELY") ||
          process.env.POST_IMMEDIATELY ||
          "false"
      ),
    };

    return twitterEnvSchema.parse(twitterConfig);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.errors
        .map((err) => `${err.path.join(".")}: ${err.message}`)
        .join("\n");
      throw new Error(
        `Twitter configuration validation failed:\n${errorMessages}`
      );
    }
    throw error;
  }
}
