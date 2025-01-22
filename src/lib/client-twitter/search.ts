import {
  Content,
  HandlerCallback,
  ModelClass,
  State,
  composeContext,
  elizaLogger,
  generateMessageResponse,
  messageCompletionFooter,
  stringToUuid,
} from "@elizaos/core";
import { IAgentRuntime } from "../../interfaces/runtime.js";
import { generateText } from "../core/generation.js";
import { ClientBase } from "./base.js";
import { buildConversationThread, sendTweet, wait } from "./utils.js";

const twitterSearchTemplate =
  `{{timeline}}

{{providers}}

Recent interactions between {{agentName}} and other users:
{{recentPostInteractions}}

About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{postDirections}}

{{recentPosts}}

# Task: Respond to the following post in the style and perspective of {{agentName}} (aka @{{twitterUserName}}). Write a {{adjective}} response for {{agentName}} to say directly in response to the post. don't generalize.
{{currentPost}}

IMPORTANT: Your response CANNOT be longer than 20 words.
Aim for 1-2 short sentences maximum. Be concise and direct.

Your response should not contain any questions. Brief, concise statements only. No emojis. Use \\n\\n (double spaces) between statements.

` + messageCompletionFooter;

export class TwitterSearchClient {
  client: ClientBase;
  runtime: IAgentRuntime;
  twitterUsername: string;
  private respondedTweets: Set<string> = new Set();

  constructor(client: ClientBase, runtime: IAgentRuntime) {
    this.client = client;
    this.runtime = runtime;
    this.twitterUsername = this.client.twitterConfig.TWITTER_USERNAME;
  }

  async start() {
    this.engageWithSearchTermsLoop();
  }

  private engageWithSearchTermsLoop() {
    this.engageWithSearchTerms().then();
    const randomMinutes = Math.floor(Math.random() * (120 - 60 + 1)) + 60;
    elizaLogger.log(
      `Next twitter search scheduled in ${randomMinutes} minutes`
    );
    setTimeout(
      () => this.engageWithSearchTermsLoop(),
      randomMinutes * 60 * 1000
    );
  }

  private async engageWithSearchTerms() {
    console.log("Engaging with search terms");
    try {
      const searchTerm = "";

      console.log("Fetching search tweets");
      // TODO: we wait 5 seconds here to avoid getting rate limited on startup, but we should queue
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const recentTweets = await this.client.fetchSearchTweets(searchTerm, 20);
      console.log("Search tweets fetched");

      const homeTimeline = await this.client.fetchHomeTimeline(50);

      await this.client.cacheTimeline(homeTimeline);

      const formattedHomeTimeline =
        `# ${this.runtime.character.name}'s Home Timeline\n\n` +
        homeTimeline
          .map((tweet) => {
            return `ID: ${tweet.id}\nFrom: ${tweet.name} (@${tweet.username})${tweet.in_reply_to_user_id ? ` In reply to: ${tweet.in_reply_to_user_id}` : ""}\nText: ${tweet.text}\n---\n`;
          })
          .join("\n");

      // randomly slice .tweets down to 20
      const slicedTweets = recentTweets
        .sort(() => Math.random() - 0.5)
        .slice(0, 20);

      if (slicedTweets.length === 0) {
        console.log("No valid tweets found for the search term", searchTerm);
        return;
      }

      const prompt = `
  Here are some tweets related to the search term "${searchTerm}":

  ${[...slicedTweets, ...homeTimeline]
    // .filter((tweet) => {
    //   // ignore tweets where any of the thread tweets contain a tweet by the bot
    //   const thread = tweet.referenced_tweets;
    //   const botTweet = thread.find((refTweet) => refTweet.username === this.twitterUsername);
    //   return !botTweet;
    // })
    .map(
      (tweet) => `
    ID: ${tweet.id}${tweet.in_reply_to_user_id ? ` In reply to: ${tweet.in_reply_to_user_id}` : ""}
    From: ${tweet.name} (@${tweet.username})
    Text: ${tweet.text}
  `
    )
    .join("\n")}

  Which tweet is the most interesting and relevant for Ruby to reply to? Please provide only the ID of the tweet in your response.
  Notes:
    - Respond to English tweets only
    - Respond to tweets that don't have a lot of hashtags, links, URLs or images
    - Respond to tweets that are not retweets
    - Respond to tweets where there is an easy exchange of ideas to have with the user
    - ONLY respond with the ID of the tweet`;

      const mostInterestingTweetResponse = await generateText({
        runtime: this.runtime as any,
        context: prompt,
        modelClass: ModelClass.SMALL,
      });

      const tweetId = mostInterestingTweetResponse.trim();
      const selectedTweet = slicedTweets.find(
        (tweet) =>
          tweet.id.toString().includes(tweetId) ||
          tweetId.includes(tweet.id.toString())
      );

      if (!selectedTweet) {
        console.log("No matching tweet found for the selected ID");
        return console.log("Selected tweet ID:", tweetId);
      }

      console.log("Selected tweet to reply to:", selectedTweet?.text);

      if (selectedTweet.username === this.twitterUsername) {
        console.log("Skipping tweet from bot itself");
        return;
      }

      const conversationId = selectedTweet.conversation_id;
      const roomId = stringToUuid(conversationId + "-" + this.runtime.agentId);

      const userIdUUID = stringToUuid(selectedTweet.author_id as string);

      await this.runtime.ensureConnection(
        userIdUUID,
        roomId,
        selectedTweet.username,
        selectedTweet.name,
        "twitter"
      );

      // crawl additional conversation tweets, if there are any
      await buildConversationThread(selectedTweet, this.client);

      const message = {
        id: stringToUuid(selectedTweet.id + "-" + this.runtime.agentId),
        agentId: this.runtime.agentId,
        content: {
          text: selectedTweet.text,
          url: `https://twitter.com/${selectedTweet.username}/status/${selectedTweet.id}`,
          inReplyTo: selectedTweet.in_reply_to_user_id
            ? stringToUuid(
                selectedTweet.in_reply_to_user_id + "-" + this.runtime.agentId
              )
            : undefined,
        },
        userId: userIdUUID,
        roomId,
        // Timestamps are in seconds, but we need them in milliseconds
        createdAt: new Date(selectedTweet.created_at!).getTime(),
      };

      if (!message.content.text) {
        return { text: "", action: "IGNORE" };
      }

      // Fetch replies and retweets
      const replies = selectedTweet.referenced_tweets;
      const replyContexts: string[] = [];
      for (const reply of replies ?? []) {
        const replyTweet = await this.client.requestQueue.add(() =>
          this.client.getTweet(reply.id)
        );

        replyContexts.push(`@${replyTweet.username}: ${replyTweet.text}`);
      }

      const replyContext = replyContexts.join("\n");
      // replies
      //   .filter((reply) => reply.username !== this.twitterUsername)
      //   .map((reply) => `@${reply.username}: ${reply.text}`)
      //   .join('\n');

      let tweetBackground = "";
      // if (selectedTweet.isRetweet) {
      //   const originalTweet = await this.client.requestQueue.add(() =>
      //     this.client.twitterClient.getTweet(selectedTweet.id),
      //   );
      //   tweetBackground = `Retweeting @${originalTweet.username}: ${originalTweet.text}`;
      // }

      // Generate image descriptions using GPT-4 vision API
      const imageDescriptions: string[] = [];
      // for (const photo of selectedTweet.photos) {
      //   const description = await this.runtime
      //     .getService<IImageDescriptionService>(ServiceType.IMAGE_DESCRIPTION)
      //     .describeImage(photo.url);
      //   imageDescriptions.push(description);
      // }

      let state = await this.runtime.composeState(message, {
        twitterClient: this.client.twitterClient,
        twitterUserName: this.twitterUsername,
        timeline: formattedHomeTimeline,
        tweetContext: `${tweetBackground}

  Original Post:
  By @${selectedTweet.username}
  ${selectedTweet.text}${replyContext.length > 0 && `\nReplies to original post:\n${replyContext}`}
  ${`Original post text: ${selectedTweet.text}`}
  ${imageDescriptions.length > 0 ? `\nImages in Post (Described): ${imageDescriptions.join(", ")}\n` : ""}
  `,
      });

      await this.client.saveRequestMessage(message, state as State);

      const context = composeContext({
        state,
        template: twitterSearchTemplate,
      });

      const responseContent = await generateMessageResponse({
        runtime: this.runtime as any,
        context,
        modelClass: ModelClass.LARGE,
      });

      responseContent.inReplyTo = message.id;

      const response = responseContent;

      if (!response.text) {
        console.log("Returning: No response text found");
        return;
      }

      console.log(
        `Bot would respond to tweet ${selectedTweet.id} with: ${response.text}`
      );
      try {
        const callback: HandlerCallback = async (response: Content) => {
          const memories = await sendTweet(
            this.client,
            response,
            message.roomId,
            this.twitterUsername,
            tweetId
          );
          return memories;
        };

        const responseMessages = await callback(responseContent);

        state = await this.runtime.updateRecentMessageState(state);

        for (const responseMessage of responseMessages) {
          await this.runtime.messageManager.createMemory(
            responseMessage,
            false
          );
        }

        state = await this.runtime.updateRecentMessageState(state);

        await this.runtime.evaluate(message, state);

        await this.runtime.processActions(
          message,
          responseMessages,
          state,
          callback
        );

        this.respondedTweets.add(selectedTweet.id);
        const responseInfo = `Context:\n\n${context}\n\nSelected Post: ${selectedTweet.id} - ${selectedTweet.username}: ${selectedTweet.text}\nAgent's Output:\n${response.text}`;

        await this.runtime.cacheManager.set(
          `twitter/tweet_generation_${selectedTweet.id}.txt`,
          responseInfo
        );

        await wait();
      } catch (error) {
        console.error(`Error sending response post: ${error}`);
      }
    } catch (error) {
      console.error("Error engaging with search terms:", error);
    }
  }
}
