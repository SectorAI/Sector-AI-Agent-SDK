import {
  composeContext,
  Memory,
  ModelClass,
  stringToUuid,
} from "@elizaos/core";
import { TwitterApi } from "twitter-api-v2";
import { env } from "../../config/index.js";
import { IAgentRuntime } from "../../interfaces/runtime.js";
import { generateMessageResponse, generateText } from "./generation.js";
import { twitterMessageHandlerTemplate } from "./templates/interactions.js";
import { twitterPostTemplate } from "./templates/post.js";
import { buildConversationThread, TweetData } from "../client-twitter/utils.js";
import { ClientBase } from "../client-twitter/base.js";

export const generateTweet = async (
  runtime: IAgentRuntime
): Promise<string> => {
  const roomId = stringToUuid("twitter_generate_room-simulate");

  const state = await runtime.composeState({
    userId: runtime.agentId,
    roomId,
    agentId: runtime.agentId,
    content: {
      text: "",
      action: "TWEET",
    },
  });

  const context = composeContext({
    state,
    template: twitterPostTemplate(
      runtime.character.promptConfig.POST?.userPrompt
    ),
  });

  const config = runtime.character.promptConfig?.POST;

  const newTweetContent = await generateText({
    runtime,
    context,
    modelClass: ModelClass.SMALL,
    modelConfig: config.modelConfig,
  });

  // First attempt to clean content
  let cleanedContent = "";

  // Try parsing as JSON first
  try {
    const parsedResponse = JSON.parse(newTweetContent);
    if (parsedResponse.text) {
      cleanedContent = parsedResponse.text;
    } else if (typeof parsedResponse === "string") {
      cleanedContent = parsedResponse;
    }
  } catch (error: any) {
    error.linted = true; // make linter happy since catch needs a variable
    // If not JSON, clean the raw content
    cleanedContent = newTweetContent
      .replace(/^\s*{?\s*"text":\s*"|"\s*}?\s*$/g, "") // Remove JSON-like wrapper
      .replace(/^['"](.*)['"]$/g, "$1") // Remove quotes
      .replace(/\\"/g, '"') // Unescape quotes
      .replace(/\\n/g, "\n") // Unescape newlines
      .trim();
  }

  if (!cleanedContent) {
    return;
  }

  const removeQuotes = (str: string) => str.replace(/^['"](.*)['"]$/, "$1");

  const fixNewLines = (str: string) => str.replace(/\\n/g, "\n");

  // Final cleaning
  cleanedContent = removeQuotes(fixNewLines(cleanedContent));

  return cleanedContent;
};

export const generateReply = async (
  runtime: IAgentRuntime,
  tweetId: string
): Promise<string> => {
  const roomId = stringToUuid("twitter_generate_room-simulate");

  const client = new ClientBase(runtime, {
    TWITTER_APP_KEY: env.twitter.consumerKey,
    TWITTER_APP_SECRET: env.twitter.consumerSecret,
    TWITTER_USERNAME: "Simulator",
    TWITTER_RETRY_LIMIT: 1,
  });

  await client.init();

  const tweet = await client.getTweet(tweetId);
  const thread = await buildConversationThread(tweet, client).catch(() => []);

  const message: Memory = {
    userId: runtime.agentId,
    agentId: runtime.agentId,
    content: {
      text: tweet.text,
      url: `https://twitter.com/${tweet.username}/status/${tweet.id}`,
      inReplyTo: tweet.in_reply_to_user_id
        ? stringToUuid(tweet.in_reply_to_user_id + "-" + runtime.agentId)
        : undefined,
    },
    roomId,
    createdAt: new Date(tweet.created_at).getTime(),
  };

  const formatTweet = (tweet: TweetData) => {
    return `  ID: ${tweet.id}
From: ${tweet.name} (@${tweet.username})
Text: ${tweet.text}`;
  };
  const currentPost = formatTweet(tweet);
  const formattedConversation = thread
    .map(
      (tweet) => `@${tweet.username} (${new Date(
        tweet.created_at
      ).toLocaleString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        month: "short",
        day: "numeric",
      })}):
    ${tweet.text}`
    )
    .join("\n\n");

  const state = await runtime.composeState(message, {
    twitterClient: client.twitterClient,
    // twitterUserName: client.twitterConfig.TWITTER_USERNAME,
    currentPost,
    formattedConversation,
  });

  const context = composeContext({
    state,
    template: twitterMessageHandlerTemplate(
      runtime.character.promptConfig.REPLY?.userPrompt
    ),
  });

  const response = await generateMessageResponse({
    runtime,
    context,
    modelClass: ModelClass.LARGE,
  });

  const removeQuotes = (str: string) => str.replace(/^['"](.*)['"]$/, "$1");

  const stringId = stringToUuid(tweet.id + "-" + runtime.agentId);

  response.inReplyTo = stringId;

  response.text = removeQuotes(response.text);

  return response.text;
};
