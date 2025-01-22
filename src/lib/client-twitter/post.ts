import {
  composeContext,
  elizaLogger,
  generateTweetActions,
  getEmbeddingZeroVector,
  ModelClass,
  stringToUuid,
  UUID,
} from "@elizaos/core";
import { IAgentRuntime } from "../../interfaces/runtime.js";
import { generateText } from "../core/generation.js";
import { ClientBase } from "./base.js";
import { DEFAULT_MAX_TWEET_LENGTH } from "./environment.js";
import { buildConversationThread, TweetData } from "./utils.js";
import { twitterPostTemplate } from "../core/templates/post.js";
import { twitterActionTemplate } from "../core/templates/action.js";
import { twitterMessageHandlerTemplate } from "../core/templates/interactions.js";

/**
 * Truncate text to fit within the Twitter character limit, ensuring it ends at a complete sentence.
 */
function truncateToCompleteSentence(
  text: string,
  maxTweetLength: number
): string {
  if (text.length <= maxTweetLength) {
    return text;
  }

  // Attempt to truncate at the last period within the limit
  const lastPeriodIndex = text.lastIndexOf(".", maxTweetLength - 1);
  if (lastPeriodIndex !== -1) {
    const truncatedAtPeriod = text.slice(0, lastPeriodIndex + 1).trim();
    if (truncatedAtPeriod.length > 0) {
      return truncatedAtPeriod;
    }
  }

  // If no period, truncate to the nearest whitespace within the limit
  const lastSpaceIndex = text.lastIndexOf(" ", maxTweetLength - 1);
  if (lastSpaceIndex !== -1) {
    const truncatedAtSpace = text.slice(0, lastSpaceIndex).trim();
    if (truncatedAtSpace.length > 0) {
      return truncatedAtSpace + "...";
    }
  }

  // Fallback: Hard truncate and add ellipsis
  const hardTruncated = text.slice(0, maxTweetLength - 3).trim();
  return hardTruncated + "...";
}

export class TwitterPostClient {
  client: ClientBase;
  runtime: IAgentRuntime;
  twitterUsername: string;
  private isProcessing: boolean = false;
  private lastProcessTime: number = 0;
  private stopProcessingActions: boolean = false;
  private isDryRun: boolean;

  constructor(client: ClientBase, runtime: IAgentRuntime) {
    this.client = client;
    this.runtime = runtime;
    this.twitterUsername = this.client.twitterConfig.TWITTER_USERNAME;
    this.isDryRun = this.client.twitterConfig.TWITTER_DRY_RUN;

    // Log configuration on initialization
    elizaLogger.log("Twitter Client Configuration:");
    elizaLogger.log(`- Username: ${this.twitterUsername}`);
    elizaLogger.log(
      `- Post config: ${this.client.character.promptConfig.POST}`
    );
    elizaLogger.log(
      `- Action Processing: ${this.client.twitterConfig.ENABLE_ACTION_PROCESSING ? "enabled" : "disabled"}`
    );
    elizaLogger.log(
      `- Action Interval: ${this.client.twitterConfig.ACTION_INTERVAL} seconds`
    );
    elizaLogger.log(
      `- Post Immediately: ${this.client.twitterConfig.POST_IMMEDIATELY ? "enabled" : "disabled"}`
    );
    elizaLogger.log(
      `- Search Enabled: ${this.client.twitterConfig.TWITTER_SEARCH_ENABLE ? "enabled" : "disabled"}`
    );

    const targetUsers = this.client.character.monitoredAccounts;
    if (targetUsers) {
      elizaLogger.log(`- Target Users: ${targetUsers}`);
    }

    if (this.isDryRun) {
      elizaLogger.log(
        "Twitter client initialized in dry run mode - no actual tweets should be posted"
      );
    }
  }

  async start() {
    if (!this.client.profile!) {
      await this.client.init();
    }

    const generateNewTweetLoop = async () => {
      const lastPost = await this.runtime.cacheManager.get<{
        timestamp: number;
      }>("twitter/" + this.twitterUsername + "/lastPost");

      const lastPostTimestamp = lastPost?.timestamp ?? 0;
      const { intervalMax = 180, intervalMin = 90 } =
        this.client.character.promptConfig.POST;
      const randomMinutes =
        Math.floor(Math.random() * (intervalMax - intervalMin + 1)) +
        intervalMin;
      const delay = randomMinutes * 60 * 1000;

      if (Date.now() > lastPostTimestamp + delay) {
        await this.generateNewTweet();
      }

      setTimeout(() => {
        generateNewTweetLoop(); // Set up next iteration
      }, delay);

      elizaLogger.log(`Next tweet scheduled in ${randomMinutes} minutes`);
    };

    const processActionsLoop = async () => {
      const actionInterval = this.client.twitterConfig.ACTION_INTERVAL; // Defaults to 5 minutes

      while (!this.stopProcessingActions) {
        try {
          const results = await this.processTweetActions();
          if (results) {
            elizaLogger.log(`Processed ${results.length} tweets`);
            elizaLogger.log(
              `Next action processing scheduled in ${actionInterval / 1000} seconds`
            );
            // Wait for the full interval before next processing
            await new Promise(
              (resolve) => setTimeout(resolve, actionInterval * 60 * 1000) // now in minutes
            );
          }
        } catch (error) {
          elizaLogger.error("Error in action processing loop:", error);
          // Add exponential backoff on error
          await new Promise((resolve) => setTimeout(resolve, 30000)); // Wait 30s on error
        }
      }
    };

    if (this.client.twitterConfig.POST_IMMEDIATELY) {
      await this.generateNewTweet();
    }

    // Only start tweet generation loop if not in dry run mode
    if (!this.isDryRun) {
      generateNewTweetLoop();
      elizaLogger.log("Tweet generation loop started");
    } else {
      elizaLogger.log("Tweet generation loop disabled (dry run mode)");
    }

    // if (this.client.twitterConfig.ENABLE_ACTION_PROCESSING && !this.isDryRun) {
    //   processActionsLoop().catch((error) => {
    //     elizaLogger.error("Fatal error in process actions loop:", error);
    //   });
    // } else {
    //   if (this.isDryRun) {
    //     elizaLogger.log("Action processing loop disabled (dry run mode)");
    //   } else {
    //     elizaLogger.log("Action processing loop disabled by configuration");
    //   }
    // }
  }

  async processAndCacheTweet(
    runtime: IAgentRuntime,
    client: ClientBase,
    tweet: TweetData,
    roomId: UUID,
    newTweetContent: string
  ) {
    // Cache the last post details
    await runtime.cacheManager.set(
      `twitter/${client.profile!.username}/lastPost`,
      {
        id: tweet.id,
        timestamp: Date.now(),
      }
    );

    // Cache the tweet
    await client.cacheTweet(tweet);

    // Log the posted tweet
    elizaLogger.log(`Tweet posted:\n ${tweet.id}`);

    // Ensure the room and participant exist
    await runtime.ensureRoomExists(roomId);
    await runtime.ensureParticipantInRoom(runtime.agentId, roomId);

    // Create a memory for the tweet
    await runtime.messageManager.createMemory({
      id: stringToUuid(tweet.id + "-" + runtime.agentId),
      userId: runtime.agentId,
      agentId: runtime.agentId,
      content: {
        text: newTweetContent.trim(),
        url: `https://twitter.com/${client.profile!.username}/status/${tweet.id}`,
        source: "twitter",
      },
      roomId,
      embedding: getEmbeddingZeroVector(),
      createdAt: new Date(tweet.created_at!).getTime(),
    });
  }

  async handleNoteTweet(
    client: ClientBase,
    runtime: IAgentRuntime,
    content: string,
    tweetId?: string
  ) {
    try {
      const noteTweetResult = await client.requestQueue.add(
        async () =>
          await client.twitterClient.v2.tweet(content, {
            reply: tweetId ? { in_reply_to_tweet_id: tweetId } : undefined,
          })
      );

      if (noteTweetResult.errors && noteTweetResult.errors.length > 0) {
        // Note Tweet failed due to authorization. Falling back to standard Tweet.
        const truncateContent = truncateToCompleteSentence(
          content,
          this.client.twitterConfig.MAX_TWEET_LENGTH
        );
        return await this.sendStandardTweet(client, truncateContent, tweetId);
      } else {
        return noteTweetResult.data;
      }
    } catch (error) {
      throw new Error(`Note Tweet failed: ${error}`);
    }
  }

  async sendStandardTweet(
    client: ClientBase,
    content: string,
    tweetId?: string
  ) {
    try {
      const standardTweetResult = await client.requestQueue.add(
        async () =>
          await client.twitterClient.v2.tweet(content, {
            reply: tweetId ? { in_reply_to_tweet_id: tweetId } : undefined,
          })
      );

      return standardTweetResult.data;
    } catch (error) {
      elizaLogger.error("Error sending standard Tweet:", error);
      throw error;
    }
  }

  async postTweet(
    runtime: IAgentRuntime,
    client: ClientBase,
    cleanedContent: string,
    roomId: UUID,
    newTweetContent: string,
    twitterUsername: string
  ) {
    try {
      elizaLogger.log(`Posting new tweet:\n`);

      let result: { id: string };

      if (cleanedContent.length > DEFAULT_MAX_TWEET_LENGTH) {
        result = await this.handleNoteTweet(client, runtime, cleanedContent);
      } else {
        result = await this.sendStandardTweet(client, cleanedContent);
      }

      const tweet = await this.client.getTweet(result.id);
      await this.processAndCacheTweet(
        runtime,
        client,
        tweet,
        roomId,
        newTweetContent
      );
    } catch (error) {
      elizaLogger.error("Error sending post tweet:", error);
    }
  }

  /**
   * Generates and posts a new tweet. If isDryRun is true, only logs what would have been posted.
   */
  private async generateNewTweet() {
    elizaLogger.log("Generating new tweet");

    try {
      const roomId = stringToUuid(
        "twitter_generate_room-" + this.client.profile!.username
      );
      elizaLogger.log(`Ensure user exists for agent: ${this.runtime.agentId}`);
      await this.runtime.ensureUserExists(
        this.runtime.agentId,
        this.client.profile!.username,
        this.runtime.character.name,
        "twitter"
      );
      elizaLogger.log("Fetching recent posts for context");
      // const topics = this.runtime.character.topics.join(", ");
      const topics = null;

      const state = await this.runtime.composeState(
        {
          userId: this.runtime.agentId,
          roomId: roomId,
          agentId: this.runtime.agentId,
          content: {
            text: topics || "",
            action: "TWEET",
          },
        },
        {
          twitterUserName: this.client.profile!.username,
        }
      );
      elizaLogger.debug("Generated state for new tweet:\n" + state);
      const context = composeContext({
        state,
        template: twitterPostTemplate(
          this.runtime.character.promptConfig.POST?.userPrompt
        ),
      });

      elizaLogger.debug("generate post prompt:\n" + context);

      elizaLogger.log("Generating new tweet content", this.client.character.promptConfig.POST.modelConfig);
      console.log(this.runtime)
      console.log(context)
      const newTweetContent = await generateText({
        runtime: this.runtime as any,
        context,
        modelClass: ModelClass.SMALL,
        modelConfig: this.client.character.promptConfig.POST.modelConfig,
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
        elizaLogger.error("Failed to extract valid content from response:", {
          rawResponse: newTweetContent,
          attempted: "JSON parsing",
        });
        return;
      }

      // Truncate the content to the maximum tweet length specified in the environment settings, ensuring the truncation respects sentence boundaries.
      const maxTweetLength = this.client.twitterConfig.MAX_TWEET_LENGTH;
      if (maxTweetLength) {
        cleanedContent = truncateToCompleteSentence(
          cleanedContent,
          maxTweetLength
        );
      }

      const removeQuotes = (str: string) => str.replace(/^['"](.*)['"]$/, "$1");

      const fixNewLines = (str: string) => str.replace(/\\n/g, "\n");

      // Final cleaning
      cleanedContent = removeQuotes(fixNewLines(cleanedContent));

      if (this.isDryRun) {
        elizaLogger.info(`Dry run: would have posted tweet: ${cleanedContent}`);
        return;
      }

      try {
        elizaLogger.log(`Posting new tweet:\n ${cleanedContent}`);
        this.postTweet(
          this.runtime,
          this.client,
          cleanedContent,
          roomId,
          newTweetContent,
          this.twitterUsername
        );
      } catch (error) {
        elizaLogger.error("Error sending post tweet in generating:", error);
      }
    } catch (error) {
      elizaLogger.error(
        "Error generating new tweet:",
        error,
        (error as Error).stack
      );
    }
  }

  private async generateTweetContent(
    tweetState: any,
    options?: {
      template?: string;
      context?: string;
    }
  ): Promise<string> {
    const config = this.client.character.promptConfig.POST;
    const context = composeContext({
      state: tweetState,
      template: options?.template || twitterPostTemplate(config?.userPrompt),
    });

    const response = await generateText({
      runtime: this.runtime as any,
      context: options?.context || context,
      modelClass: ModelClass.SMALL,
      modelConfig: config?.modelConfig,
    });
    elizaLogger.debug("generate tweet content response:\n" + response);

    // First clean up any markdown and newlines
    const cleanedResponse = response
      .replace(/```json\s*/g, "") // Remove ```json
      .replace(/```\s*/g, "") // Remove any remaining ```
      .replace(/\\n/g, "\n")
      .trim();

    // Try to parse as JSON first
    try {
      const jsonResponse = JSON.parse(cleanedResponse);
      if (jsonResponse.text) {
        return this.trimTweetLength(jsonResponse.text);
      }
      if (typeof jsonResponse === "object") {
        const possibleContent =
          jsonResponse.content || jsonResponse.message || jsonResponse.response;
        if (possibleContent) {
          return this.trimTweetLength(possibleContent);
        }
      }
    } catch (error: any) {
      error.linted = true; // make linter happy since catch needs a variable

      // If JSON parsing fails, treat as plain text
      elizaLogger.debug("Response is not JSON, treating as plain text");
    }

    // If not JSON or no valid content found, clean the raw text
    return this.trimTweetLength(cleanedResponse);
  }

  // Helper method to ensure tweet length compliance
  private trimTweetLength(text: string, maxLength: number = 280): string {
    if (text.length <= maxLength) return text;

    // Try to cut at last sentence
    const lastSentence = text.slice(0, maxLength).lastIndexOf(".");
    if (lastSentence > 0) {
      return text.slice(0, lastSentence + 1).trim();
    }

    // Fallback to word boundary
    return text.slice(0, text.lastIndexOf(" ", maxLength - 3)).trim() + "...";
  }

  /**
   * Processes tweet actions (likes, retweets, quotes, replies). If isDryRun is true,
   * only simulates and logs actions without making API calls.
   */
  private async processTweetActions() {
    if (this.isProcessing) {
      elizaLogger.log("Already processing tweet actions, skipping");
      return null;
    }

    try {
      this.isProcessing = true;
      this.lastProcessTime = Date.now();

      elizaLogger.log("Processing tweet actions");

      if (this.isDryRun) {
        elizaLogger.log("Dry run mode: simulating tweet actions");
        return [];
      }
      elizaLogger.log("Ensure user exists for agent");
      await this.runtime.ensureUserExists(
        this.runtime.agentId,
        this.twitterUsername,
        this.runtime.character.name,
        "twitter"
      );

      elizaLogger.log("Fetching home timeline for actions");
      const homeTimeline = await this.client.fetchTimelineForActions(1);
      const results = [];

      elizaLogger.log(`Processing ${homeTimeline.length} tweets`);
      for (const tweet of homeTimeline) {
        try {
          // Skip if we've already processed this tweet
          const memory = await this.runtime.messageManager.getMemoryById(
            stringToUuid(tweet.id + "-" + this.runtime.agentId)
          );
          if (memory) {
            elizaLogger.log(`Already processed tweet ID: ${tweet.id}`);
            continue;
          }

          const roomId = stringToUuid(
            tweet.conversation_id + "-" + this.runtime.agentId
          );

          elizaLogger.log(`Processing tweet ID: ${tweet.id}`);
          const { data: tweetUser } = await this.client.twitterClient.v2.user(
            tweet.author_id!
          );

          elizaLogger.log(`Processing tweet from user: ${tweetUser.username}`);
          const tweetState = await this.runtime.composeState(
            {
              userId: this.runtime.agentId,
              roomId,
              agentId: this.runtime.agentId,
              content: { text: "", action: "" },
            },
            {
              twitterUserName: this.twitterUsername,
              currentTweet: `ID: ${tweet.id}\nFrom: ${tweetUser.name} (@${tweetUser.username})\nText: ${tweet.text}`,
            }
          );

          const actionContext = composeContext({
            state: tweetState,
            template: twitterActionTemplate,
          });

          elizaLogger.debug("Action context");
          const actionResponse = await generateTweetActions({
            runtime: this.runtime as any,
            context: actionContext,
            modelClass: ModelClass.SMALL,
          });

          if (!actionResponse) {
            elizaLogger.log(`No valid actions generated for tweet ${tweet.id}`);
            continue;
          }

          const executedActions: string[] = [];

          // Execute actions
          if (actionResponse.like) {
            try {
              if (this.isDryRun) {
                elizaLogger.info(`Dry run: would have liked tweet ${tweet.id}`);
                executedActions.push("like (dry run)");
              } else {
                await this.client.twitterClient.v2.like(
                  this.client.profile!.id,
                  tweet.id
                );
                executedActions.push("like");
                elizaLogger.log(`Liked tweet ${tweet.id}`);
              }
            } catch (error) {
              elizaLogger.error(`Error liking tweet ${tweet.id}:`, error);
            }
          }

          if (actionResponse.retweet) {
            try {
              if (this.isDryRun) {
                elizaLogger.info(
                  `Dry run: would have retweeted tweet ${tweet.id}`
                );
                executedActions.push("retweet (dry run)");
              } else {
                await this.client.twitterClient.v2.retweet(
                  this.client.profile!.id,
                  tweet.id
                );
                executedActions.push("retweet");
                elizaLogger.log(`Retweeted tweet ${tweet.id}`);
              }
            } catch (error) {
              elizaLogger.error(`Error retweeting tweet ${tweet.id}:`, error);
            }
          }

          if (actionResponse.quote) {
            try {
              // Check for dry run mode
              if (this.isDryRun) {
                elizaLogger.info(
                  `Dry run: would have posted quote tweet for ${tweet.id}`
                );
                executedActions.push("quote (dry run)");
                continue;
              }

              // Build conversation thread for context
              const thread = await buildConversationThread(tweet, this.client);
              const formattedConversation = thread
                .map(
                  (t) =>
                    `@${t.author_id} (${new Date(t.created_at!).toLocaleString()}): ${t.text}`
                )
                .join("\n\n");

              // Generate image descriptions if present
              const imageDescriptions: string[] = [];
              // if (tweet.photos?.length > 0) {
              //   elizaLogger.log('Processing images in tweet for context');
              //   for (const photo of tweet.photos) {
              //     const description = await this.runtime
              //       .getService<IImageDescriptionService>(
              //         ServiceType.IMAGE_DESCRIPTION,
              //       )
              //       .describeImage(photo.url);
              //     imageDescriptions.push(description);
              //   }
              // }

              // Handle quoted tweet if present
              let quotedContent = "";
              // if (tweet.quotedStatusId) {
              //   try {
              //     const quotedTweet = await this.client.twitterClient.getTweet(
              //       tweet.quotedStatusId,
              //     );
              //     if (quotedTweet) {
              //       quotedContent = `\nQuoted Tweet from @${quotedTweet.username}:\n${quotedTweet.text}`;
              //     }
              //   } catch (error) {
              //     elizaLogger.error('Error fetching quoted tweet:', error);
              //   }
              // }

              // Compose rich state with all context
              const enrichedState = await this.runtime.composeState(
                {
                  userId: this.runtime.agentId,
                  roomId: stringToUuid(
                    tweet.conversation_id + "-" + this.runtime.agentId
                  ),
                  agentId: this.runtime.agentId,
                  content: {
                    text: tweet.text,
                    action: "QUOTE",
                  },
                },
                {
                  twitterUserName: this.twitterUsername,
                  currentPost: `From @${tweet.username}: ${tweet.text}`,
                  formattedConversation,
                  imageContext:
                    imageDescriptions.length > 0
                      ? `\nImages in Tweet:\n${imageDescriptions.map((desc, i) => `Image ${i + 1}: ${desc}`).join("\n")}`
                      : "",
                  quotedContent,
                }
              );

              const quoteContent = await this.generateTweetContent(
                enrichedState,
                {
                  template: twitterMessageHandlerTemplate(
                    this.runtime.character.promptConfig.QUOTE?.userPrompt
                  ),
                }
              );

              if (!quoteContent) {
                elizaLogger.error(
                  "Failed to generate valid quote tweet content"
                );
                return;
              }

              elizaLogger.log("Generated quote tweet content:", quoteContent);

              // Send the tweet through request queue
              const result = await this.client.requestQueue.add(
                async () =>
                  await this.client.twitterClient.v2.tweet(quoteContent, {
                    quote_tweet_id: tweet.id,
                  })
              );

              if (result?.data) {
                elizaLogger.log("Successfully posted quote tweet");
                executedActions.push("quote");

                // Cache generation context for debugging
                await this.runtime.cacheManager.set(
                  `twitter/quote_generation_${tweet.id}.txt`,
                  `Context:\n${enrichedState}\n\nGenerated Quote:\n${quoteContent}`
                );
              } else {
                elizaLogger.error("Quote tweet creation failed:", result);
              }
            } catch (error) {
              elizaLogger.error("Error in quote tweet generation:", error);
            }
          }

          if (actionResponse.reply) {
            try {
              const user = await this.client.fetchUser(tweet.author_id!);
              await this.handleTextOnlyReply(
                {
                  ...tweet,
                  username: user.username,
                  name: user.name,
                },
                tweetState,
                executedActions
              );
            } catch (error) {
              elizaLogger.error(`Error replying to tweet ${tweet.id}:`, error);
            }
          }

          // Add these checks before creating memory
          await this.runtime.ensureRoomExists(roomId);
          await this.runtime.ensureUserExists(
            stringToUuid(tweet.author_id!),
            tweet.username,
            tweet.name,
            "twitter"
          );
          await this.runtime.ensureParticipantInRoom(
            this.runtime.agentId,
            roomId
          );

          // Then create the memory
          await this.runtime.messageManager.createMemory({
            id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
            userId: stringToUuid(tweet.author_id!),
            content: {
              text: tweet.text,
              url: `https://twitter.com/${tweet.username}/status/${tweet.id}`,
              source: "twitter",
              action: executedActions.join(","),
            },
            agentId: this.runtime.agentId,
            roomId,
            embedding: getEmbeddingZeroVector(),
            createdAt: new Date(tweet.created_at!).getTime(),
          });

          results.push({
            tweetId: tweet.id,
            parsedActions: actionResponse,
            executedActions,
          });
        } catch (error) {
          elizaLogger.error(`Error processing tweet ${tweet.id}:`, error);
          continue;
        }
      }

      return results; // Return results array to indicate completion
    } catch (error) {
      elizaLogger.error("Error in processTweetActions:", error);
      throw error;
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Handles text-only replies to tweets. If isDryRun is true, only logs what would
   * have been replied without making API calls.
   */
  private async handleTextOnlyReply(
    tweet: TweetData,
    tweetState: any,
    executedActions: string[]
  ) {
    try {
      // Build conversation thread for context
      const thread = await buildConversationThread(tweet, this.client);
      const formattedConversation = thread
        .map(
          (t) =>
            `@${t.username} (${new Date(t.created_at!).toLocaleString()}): ${t.text}`
        )
        .join("\n\n");

      // Generate image descriptions if present
      const imageDescriptions: string[] = [];
      // if (tweet.photos?.length > 0) {
      //   elizaLogger.log('Processing images in tweet for context');
      //   for (const photo of tweet.photos) {
      //     const description = await this.runtime
      //       .getService<IImageDescriptionService>(ServiceType.IMAGE_DESCRIPTION)
      //       .describeImage(photo.url);
      //     imageDescriptions.push(description);
      //   }
      // }

      // Handle quoted tweet if present
      let quotedContent = "";
      // if (tweet.quotedStatusId) {
      //   try {
      //     const quotedTweet = await this.client.twitterClient.getTweet(
      //       tweet.quotedStatusId,
      //     );
      //     if (quotedTweet) {
      //       quotedContent = `\nQuoted Tweet from @${quotedTweet.username}:\n${quotedTweet.text}`;
      //     }
      //   } catch (error) {
      //     elizaLogger.error('Error fetching quoted tweet:', error);
      //   }
      // }

      // Compose rich state with all context
      const enrichedState = await this.runtime.composeState(
        {
          userId: this.runtime.agentId,
          roomId: stringToUuid(
            tweet.conversation_id + "-" + this.runtime.agentId
          ),
          agentId: this.runtime.agentId,
          content: { text: tweet.text, action: "" },
        },
        {
          twitterUserName: this.twitterUsername,
          currentPost: `From @${tweet.username}: ${tweet.text}`,
          formattedConversation,
          imageContext:
            imageDescriptions.length > 0
              ? `\nImages in Tweet:\n${imageDescriptions.map((desc, i) => `Image ${i + 1}: ${desc}`).join("\n")}`
              : "",
          quotedContent,
        }
      );

      // Generate and clean the reply content
      const replyText = await this.generateTweetContent(enrichedState, {
        template: twitterMessageHandlerTemplate(
          this.runtime.character.promptConfig.REPLY?.userPrompt
        ),
      });

      if (!replyText) {
        elizaLogger.error("Failed to generate valid reply content");
        return;
      }

      if (this.isDryRun) {
        elizaLogger.info(
          `Dry run: reply to tweet ${tweet.id} would have been: ${replyText}`
        );
        executedActions.push("reply (dry run)");
        return;
      }

      elizaLogger.debug("Final reply text to be sent:", replyText);

      let result;

      if (replyText.length > DEFAULT_MAX_TWEET_LENGTH) {
        result = await this.handleNoteTweet(
          this.client,
          this.runtime,
          replyText,
          tweet.id
        );
      } else {
        result = await this.sendStandardTweet(this.client, replyText, tweet.id);
      }

      if (result) {
        elizaLogger.log("Successfully posted reply tweet");
        executedActions.push("reply");

        // Cache generation context for debugging
        await this.runtime.cacheManager.set(
          `twitter/reply_generation_${tweet.id}.txt`,
          `Context:\n${enrichedState}\n\nGenerated Reply:\n${replyText}`
        );
      } else {
        elizaLogger.error("Tweet reply creation failed");
      }
    } catch (error) {
      elizaLogger.error("Error in handleTextOnlyReply:", error);
    }
  }

  async stop() {
    this.stopProcessingActions = true;
  }
}
