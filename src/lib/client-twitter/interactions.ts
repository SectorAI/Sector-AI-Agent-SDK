import {
  composeContext,
  Content,
  elizaLogger,
  generateMessageResponse,
  generateShouldRespond,
  getEmbeddingZeroVector,
  HandlerCallback,
  Memory,
  ModelClass,
  State,
  stringToUuid,
} from "@elizaos/core";
import { IAgentRuntime } from "../../interfaces/runtime.js";
import {
  twitterMessageHandlerTemplate,
  twitterShouldRespondTemplate,
} from "../core/templates/interactions.js";
import { ClientBase } from "./base.js";
import {
  buildConversationThread,
  sendTweet,
  TweetData,
  wait,
} from "./utils.js";

export class TwitterInteractionClient {
  client: ClientBase;
  runtime: IAgentRuntime;
  constructor(client: ClientBase, runtime: IAgentRuntime) {
    this.client = client;
    this.runtime = runtime;
  }

  async start() {
    const handleTwitterInteractionsLoop = () => {
      const { intervalMax = 10, intervalMin = 5 } =
        this.client.character.promptConfig.POST;
      const randomMinutes =
        Math.floor(Math.random() * (intervalMax - intervalMin + 1)) +
        intervalMin;
      const delay = randomMinutes * 60 * 1000;

      setTimeout(
        async () => {
          await this.handleTwitterInteractions();
          handleTwitterInteractionsLoop();
        },
        // Defaults to 2 minutes
        delay
      );
    };

    handleTwitterInteractionsLoop();
  }

  async handleTwitterInteractions() {
    elizaLogger.log("Checking Twitter interactions");

    const twitterUsername = this.client.profile!.username;
    try {
      // Check for mentions
      const mentionCandidates = await this.client.fetchSearchTweets(
        `@${twitterUsername}`,
        20
        // SearchMode.Latest,
      );

      elizaLogger.log(
        "Completed checking mentioned tweets:",
        mentionCandidates.length
      );
      let uniqueTweetCandidates = [...mentionCandidates];

      const TARGET_USERS = this.client.character.monitoredAccounts;
      // Only process target users if configured
      if (TARGET_USERS.length) {
        elizaLogger.log("Processing target users:", TARGET_USERS);

        if (TARGET_USERS.length > 0) {
          // Create a map to store tweets by user
          const tweetsByUser = new Map<string, TweetData[]>();

          // randomly pick 1 user
          const user =
            TARGET_USERS[Math.floor(Math.random() * TARGET_USERS.length)];

          // Fetch tweets from all target users

          try {
            const userTweets = (
              await this.client.twitterClient.v2.search(
                `from:${user.username}`,
                {
                  max_results: 10,
                  sort_order: "recency",
                  expansions: ["author_id", "in_reply_to_user_id"],
                }
              )
            ).tweets;

            // Filter for unprocessed, non-reply, recent tweets
            const validTweets: TweetData[] = [];

            elizaLogger.log(`Fetched ${userTweets.length} tweets for ${user}`);

            const userInfo = await this.client.fetchProfile(user.username);

            // randomly pick 1 tweet
            const tweet =
              userTweets[Math.floor(Math.random() * userTweets.length)];

            const isUnprocessed =
              !this.client.lastCheckedTweetId ||
              BigInt(tweet.id) > this.client.lastCheckedTweetId;

            elizaLogger.log(
              `Infor: ${tweet.created_at}, ${tweet.author_id}, ${tweet.id}`
            );
            console.log("this Tweet", tweet);

            elizaLogger.log(`Tweet ${tweet.id} checks:`, {
              isUnprocessed,
            });

            if (
              isUnprocessed
              // !tweet.isReply &&
              // !tweet.isRetweet &&
              // isRecent
            ) {
              validTweets.push({
                ...tweet,
                name: userInfo.screenName,
                username: user.username,
              });
            }

            if (validTweets.length > 0) {
              tweetsByUser.set(user.username, validTweets);
              elizaLogger.log(
                `Found ${validTweets.length} valid tweets from ${user}`
              );
            }
          } catch (error) {
            elizaLogger.error(`Error fetching tweets for ${user}:`, error);
          }

          // Select one tweet from each user that has tweets
          const selectedTweets: TweetData[] = [];
          for (const [username, tweets] of tweetsByUser) {
            if (tweets.length > 0) {
              // Randomly select one tweet from this user
              const randomTweet =
                tweets[Math.floor(Math.random() * tweets.length)];
              selectedTweets.push(randomTweet);
              elizaLogger.log(
                `Selected tweet from ${username}: ${randomTweet.text?.substring(0, 100)}`
              );
            }
          }

          // Add selected tweets to candidates
          uniqueTweetCandidates = [...mentionCandidates, ...selectedTweets];
        }
      } else {
        elizaLogger.log("No target users configured, processing only mentions");
      }

      // Sort tweet candidates by ID in ascending order
      uniqueTweetCandidates
        .sort((a, b) => a.id.localeCompare(b.id))
        .filter((tweet) => tweet.author_id !== this.client.profile!.id);

      // for each tweet candidate, handle the tweet
      for (const tweet of uniqueTweetCandidates) {
        if (
          !this.client.lastCheckedTweetId ||
          BigInt(tweet.id) > this.client.lastCheckedTweetId
        ) {
          // Generate the tweetId UUID the same way it's done in handleTweet
          const tweetId = stringToUuid(tweet.id + "-" + this.runtime.agentId);

          // Check if we've already processed this tweet
          const existingResponse =
            await this.runtime.messageManager.getMemoryById(tweetId);

          if (existingResponse) {
            elizaLogger.log(`Already responded to tweet ${tweet.id}, skipping`);
            continue;
          }
          elizaLogger.log("New Tweet found", tweet.id);

          const roomId = stringToUuid(
            tweet.conversation_id + "-" + this.runtime.agentId
          );

          const userIdUUID =
            tweet.author_id === this.client.profile!.id
              ? this.runtime.agentId
              : stringToUuid(tweet.author_id!);

          const user = await this.client.fetchUser(tweet.author_id!);
          await this.runtime.ensureConnection(
            userIdUUID,
            roomId,
            user.username,
            user.name,
            "twitter"
          );

          const tweetData = {
            ...tweet,
            username: user.username,
            name: user.name,
          };

          const thread = await buildConversationThread(tweetData, this.client);

          const message = {
            content: { text: tweet.text },
            agentId: this.runtime.agentId,
            userId: userIdUUID,
            roomId,
          };

          await this.handleTweet({
            tweet: tweetData,
            message,
            thread,
          });

          // Update the last checked tweet ID after processing each tweet
          this.client.lastCheckedTweetId = BigInt(tweet.id);
        }
      }

      // Save the latest checked tweet ID to the file
      await this.client.cacheLatestCheckedTweetId();

      elizaLogger.log("Finished checking Twitter interactions");
    } catch (error) {
      elizaLogger.error("Error handling Twitter interactions:", error);
    }
  }

  private async handleTweet({
    tweet,
    message,
    thread,
  }: {
    tweet: TweetData;
    message: Memory;
    thread: TweetData[];
  }) {
    if (tweet.author_id === this.client.profile!.id) {
      // console.log("skipping tweet from bot itself", tweet.id);
      // Skip processing if the tweet is from the bot itself
      return;
    }

    if (!message.content.text) {
      elizaLogger.log("Skipping Tweet with no text", tweet.id);
      return { text: "", action: "IGNORE" };
    }

    elizaLogger.log("Processing Tweet: ", tweet.id);
    const formatTweet = (tweet: TweetData) => {
      return `  ID: ${tweet.id}
  From: ${tweet.name} (@${tweet.username})
  Text: ${tweet.text}`;
    };
    const currentPost = formatTweet(tweet);

    elizaLogger.debug("Thread: ", thread);
    const formattedConversation = thread
      .map(
        (tweet) => `@${tweet.username} (${new Date(
          tweet.created_at!
        ).toLocaleString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          month: "short",
          day: "numeric",
        })}):
        ${tweet.text}`
      )
      .join("\n\n");

    elizaLogger.debug("formattedConversation: ", formattedConversation);

    let state = await this.runtime.composeState(message, {
      twitterClient: this.client.twitterClient,
      twitterUserName: this.client.twitterConfig.TWITTER_USERNAME,
      currentPost,
      formattedConversation,
    });

    // check if the tweet exists, save if it doesn't
    const tweetId = stringToUuid(tweet.id + "-" + this.runtime.agentId);
    const tweetExists =
      await this.runtime.messageManager.getMemoryById(tweetId);

    if (!tweetExists) {
      elizaLogger.log("tweet does not exist, saving");
      const userIdUUID = stringToUuid(tweet.author_id as string);
      const roomId = stringToUuid(tweet.conversation_id!);

      const message = {
        id: tweetId,
        agentId: this.runtime.agentId,
        content: {
          text: tweet.text,
          url: `https://twitter.com/${tweet.username}/status/${tweet.id}`,
          inReplyTo: tweet.in_reply_to_user_id
            ? stringToUuid(
                tweet.in_reply_to_user_id + "-" + this.runtime.agentId
              )
            : undefined,
        },
        userId: userIdUUID,
        roomId,
        createdAt: new Date(tweet.created_at!).getTime(),
      };
      this.client.saveRequestMessage(message, state);
    }

    // get usernames into str
    const validTargetUsersStr = this.client.character.monitoredAccounts
      .map(({ reason, username }) => `@${username} (${reason})`)
      .join(", ");

    const shouldRespondContext = composeContext({
      state,
      template: twitterShouldRespondTemplate(validTargetUsersStr),
    });

    const shouldRespond = await generateShouldRespond({
      runtime: this.runtime as any,
      context: shouldRespondContext,
      modelClass: ModelClass.MEDIUM,
    });

    // Promise<"RESPOND" | "IGNORE" | "STOP" | null> {
    if (shouldRespond !== "RESPOND") {
      elizaLogger.log("Not responding to message");
      return { text: "Response Decision:", action: shouldRespond };
    }

    const context = composeContext({
      state,
      template: twitterMessageHandlerTemplate(
        this.runtime.character.promptConfig.REPLY?.userPrompt
      ),
    });

    elizaLogger.debug("Interactions prompt:\n" + context);

    const response = await generateMessageResponse({
      runtime: this.runtime as any,
      context,
      modelClass: ModelClass.LARGE,
    });

    const removeQuotes = (str: string) => str.replace(/^['"](.*)['"]$/, "$1");

    const stringId = stringToUuid(tweet.id + "-" + this.runtime.agentId);

    response.inReplyTo = stringId;

    response.text = removeQuotes(response.text);

    if (response.text) {
      try {
        const callback: HandlerCallback = async (response: Content) => {
          const memories = await sendTweet(
            this.client,
            response,
            message.roomId,
            this.client.twitterConfig.TWITTER_USERNAME,
            tweet.id
          );
          return memories;
        };

        const responseMessages = await callback(response);

        state = (await this.runtime.updateRecentMessageState(state)) as State;

        for (const responseMessage of responseMessages) {
          if (
            responseMessage === responseMessages[responseMessages.length - 1]
          ) {
            responseMessage.content.action = response.action;
          } else {
            responseMessage.content.action = "CONTINUE";
          }
          await this.runtime.messageManager.createMemory(responseMessage);
        }

        await this.runtime.processActions(
          message,
          responseMessages,
          state,
          callback
        );

        const responseInfo = `Context:\n\n${context}\n\nSelected Post: ${tweet.id} - ${tweet.username}: ${tweet.text}\nAgent's Output:\n${response.text}`;

        await this.runtime.cacheManager.set(
          `twitter/tweet_generation_${tweet.id}.txt`,
          responseInfo
        );
        await wait();
      } catch (error) {
        elizaLogger.error(`Error sending response tweet: ${error}`);
      }
    }
  }

  async buildConversationThread(
    tweet: TweetData,
    maxReplies: number = 10
  ): Promise<TweetData[]> {
    const thread: TweetData[] = [];
    const visited: Set<string> = new Set();

    const processThread = async (
      currentTweet: TweetData,
      depth: number = 0
    ) => {
      elizaLogger.log("Processing tweet:", {
        id: currentTweet.id,
        inReplyToStatusId: currentTweet.in_reply_to_user_id,
        depth: depth,
      });

      if (!currentTweet) {
        elizaLogger.log("No current tweet found for thread building");
        return;
      }

      if (depth >= maxReplies) {
        elizaLogger.log("Reached maximum reply depth", depth);
        return;
      }

      // Handle memory storage
      const memory = await this.runtime.messageManager.getMemoryById(
        stringToUuid(currentTweet.id + "-" + this.runtime.agentId)
      );
      if (!memory) {
        const roomId = stringToUuid(
          currentTweet.conversation_id + "-" + this.runtime.agentId
        );
        const userId = stringToUuid(currentTweet.author_id!);
        const user = await this.client.twitterClient.v2.user(
          currentTweet.author_id!
        );
        await this.runtime.ensureConnection(
          userId,
          roomId,
          user.data.username,
          user.data.name,
          "twitter"
        );

        this.runtime.messageManager.createMemory({
          id: stringToUuid(currentTweet.id + "-" + this.runtime.agentId),
          agentId: this.runtime.agentId,
          content: {
            text: currentTweet.text,
            source: "twitter",
            url: `https://twitter.com/${currentTweet.username}/status/${currentTweet.id}`,
            inReplyTo: currentTweet.in_reply_to_user_id
              ? stringToUuid(
                  currentTweet.in_reply_to_user_id + "-" + this.runtime.agentId
                )
              : undefined,
          },
          createdAt: new Date(currentTweet.created_at!).getTime(),
          roomId,
          userId:
            currentTweet.author_id === this.client.profile!.id
              ? this.runtime.agentId
              : stringToUuid(currentTweet.author_id!),
          embedding: getEmbeddingZeroVector(),
        });
      }

      if (visited.has(currentTweet.id)) {
        elizaLogger.log("Already visited tweet:", currentTweet.id);
        return;
      }

      visited.add(currentTweet.id);
      thread.unshift(currentTweet);

      elizaLogger.debug("Current thread state:", {
        length: thread.length,
        currentDepth: depth,
        tweetId: currentTweet.id,
      });

      if (currentTweet.in_reply_to_user_id) {
        elizaLogger.log(
          "Fetching parent tweet:",
          currentTweet.in_reply_to_user_id
        );
        try {
          const parentTweet = await this.client.getTweet(
            currentTweet.in_reply_to_user_id
          );

          if (parentTweet) {
            elizaLogger.log("Found parent tweet:", {
              id: parentTweet.id,
              text: parentTweet.text?.slice(0, 50),
            });
            await processThread(parentTweet, depth + 1);
          } else {
            elizaLogger.log(
              "No parent tweet found for:",
              currentTweet.in_reply_to_user_id
            );
          }
        } catch (error) {
          elizaLogger.log("Error fetching parent tweet:", {
            tweetId: currentTweet.in_reply_to_user_id,
            error,
          });
        }
      } else {
        elizaLogger.log("Reached end of reply chain at:", currentTweet.id);
      }
    };

    // Need to bind this context for the inner function
    await processThread.bind(this)(tweet, 0);

    elizaLogger.debug("Final thread built:", {
      totalTweets: thread.length,
      tweetIds: thread.map((t) => ({
        id: t.id,
        text: t.text?.slice(0, 50),
      })),
    });

    return thread;
  }
}
