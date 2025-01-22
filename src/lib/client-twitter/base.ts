import {
  Content,
  IImageDescriptionService,
  Memory,
  State,
  UUID,
  elizaLogger,
  getEmbeddingZeroVector,
  stringToUuid,
} from "@elizaos/core";
import { EventEmitter } from "events";
import { TwitterApi } from "twitter-api-v2";
import { Character } from "../../interfaces/character.js";
import { IAgentRuntime } from "../../interfaces/runtime.js";
import { TwitterConfig } from "./environment.js";
import { TweetData } from "./utils.js";

export function extractAnswer(text: string): string {
  const startIndex = text.indexOf("Answer: ") + 8;
  const endIndex = text.indexOf("<|endoftext|>", 11);
  return text.slice(startIndex, endIndex);
}

type TwitterProfile = {
  id: string;
  username: string;
  screenName: string;
  bio: string;
  nicknames: string[];
};

class RequestQueue {
  private queue: (() => Promise<any>)[] = [];
  private processing: boolean = false;

  async add<T>(request: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await request();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) {
      return;
    }
    this.processing = true;

    while (this.queue.length > 0) {
      const request = this.queue.shift()!;
      try {
        await request();
      } catch (error) {
        console.error("Error processing request:", error);
        this.queue.unshift(request);
        await this.exponentialBackoff(this.queue.length);
      }
      await this.randomDelay();
    }

    this.processing = false;
  }

  private async exponentialBackoff(retryCount: number): Promise<void> {
    const delay = Math.pow(2, retryCount) * 1000;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  private async randomDelay(): Promise<void> {
    const delay = Math.floor(Math.random() * 2000) + 1500;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

export class ClientBase extends EventEmitter {
  static _twitterClients: { [accountIdentifier: string]: TwitterApi } = {};
  twitterClient: TwitterApi;
  runtime: IAgentRuntime;
  twitterConfig: TwitterConfig;
  directions: string;
  lastCheckedTweetId: bigint | null = null;
  imageDescriptionService: IImageDescriptionService;
  temperature: number = 0.5;
  character: Character;
  requestQueue: RequestQueue = new RequestQueue();

  profile: TwitterProfile | null;

  constructor(runtime: IAgentRuntime, twitterConfig: TwitterConfig) {
    super();
    this.runtime = runtime;
    this.twitterConfig = twitterConfig;
    const username = twitterConfig.TWITTER_USERNAME;
    const appKey = twitterConfig.TWITTER_APP_KEY;
    const appSecret = twitterConfig.TWITTER_APP_SECRET;

    if (ClientBase._twitterClients[username]) {
      this.twitterClient = ClientBase._twitterClients[username];
    } else {
      this.twitterClient = new TwitterApi({ appKey, appSecret });
      ClientBase._twitterClients[username] = this.twitterClient;
    }
    this.character = runtime.character;

    // this.directions =
    //   "- " +
    //   this.character.style.all.join("\n- ") +
    //   "- " +
    //   this.character.style.post.join();
  }

  async cacheTweet(tweet: TweetData): Promise<void> {
    if (!tweet) {
      console.warn("Tweet is undefined, skipping cache");
      return;
    }

    this.runtime.cacheManager.set(`twitter/tweets/${tweet.id}`, tweet);
  }

  async getCachedTweet(tweetId: string): Promise<TweetData | undefined> {
    const cached = await this.runtime.cacheManager.get<TweetData>(
      `twitter/tweets/${tweetId}`
    );

    return cached;
  }

  async getTweet(tweetId: string): Promise<TweetData> {
    const cachedTweet = await this.getCachedTweet(tweetId);

    if (cachedTweet) {
      return cachedTweet;
    }

    const { data: tweet } = await this.requestQueue.add(() =>
      this.twitterClient.v2.singleTweet(tweetId, {
        expansions: [
          "author_id",
          "in_reply_to_user_id",
          "referenced_tweets.id",
        ],
      })
    );

    const tweetUser = await this.fetchUser(tweet.author_id!);

    const tweetData: TweetData = {
      ...tweet,
      username: tweetUser.username,
      name: tweetUser.name,
    };

    await this.cacheTweet(tweetData);
    return tweetData;
  }

  onReady() {
    throw new Error("Not implemented in base class, please call from subclass");
  }

  async init() {
    const username = this.twitterConfig.TWITTER_USERNAME;
    const appKey = this.twitterConfig.TWITTER_APP_KEY;
    const appSecret = this.twitterConfig.TWITTER_APP_SECRET;
    const accessToken = this.twitterConfig.TWITTER_ACCESS_TOKEN;
    const accessSecret = this.twitterConfig.TWITTER_ACCESS_SECRET;
    let retries = this.twitterConfig.TWITTER_RETRY_LIMIT;

    if (!username) {
      throw new Error("Twitter username not configured");
    }

    const cachedCookies = await this.getCachedCookies(username);

    if (cachedCookies) {
      elizaLogger.info("Using cached cookies");
      await this.setCookiesFromArray(cachedCookies);
    }

    elizaLogger.log("Waiting for Twitter login");
    while (retries > 0) {
      try {
        if (!accessToken && !accessSecret) {
          console.log("Yes");

          this.twitterClient = await this.twitterClient.appLogin();
          return;
        }

        this.twitterClient = new TwitterApi({
          appKey,
          appSecret,
          accessToken,
          accessSecret,
        });

        break;
      } catch (error: any) {
        elizaLogger.error(`Login attempt failed: ${error.message}`);
      }

      retries--;
      elizaLogger.error(
        `Failed to login to Twitter. Retrying... (${retries} attempts left)`
      );

      if (retries === 0) {
        elizaLogger.error("Max retries reached. Exiting login process.");
        throw new Error("Twitter login failed after maximum retries.");
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    // Initialize Twitter profile
    this.profile = await this.fetchProfile(username);

    if (this.profile) {
      elizaLogger.log("Twitter user ID:", this.profile.id);
      elizaLogger.log(
        "Twitter loaded:",
        JSON.stringify(this.profile, null, 10)
      );
      // TODO: Store profile info for use in responses
      this.character.twitterProfile = {
        id: this.profile.id,
        username: this.profile.username,
        screenName: this.profile.screenName,
        bio: this.profile.bio,
        nicknames: this.profile.nicknames,
      };
    } else {
      throw new Error("Failed to load profile");
    }

    await this.loadLatestCheckedTweetId();

    // TODO: Fix this
    // await this.populateTimeline();
  }

  async fetchOwnPosts(count: number): Promise<TweetData[]> {
    elizaLogger.debug("fetching own posts");
    const homeTimeline = await this.twitterClient.v2.userTimeline(
      this.profile!.id,
      { max_results: count, expansions: ["author_id", "in_reply_to_user_id"] }
    );

    const tweets: TweetData[] = [];
    for (const tweet of homeTimeline.data.data) {
      const tweetUser = await this.fetchUser(tweet.author_id!);
      tweets.push({
        ...tweet,
        username: tweetUser.username,
        name: tweetUser.name,
      });
    }

    return tweets;
  }

  /**
   * Fetch timeline for twitter account, optionally only from followed accounts
   */
  async fetchHomeTimeline(count: number): Promise<TweetData[]> {
    elizaLogger.debug("fetching home timeline");
    const homeTimeline = await this.twitterClient.v2.homeTimeline({
      max_results: count,
      expansions: ["author_id", "in_reply_to_user_id"],
    });

    elizaLogger.debug(homeTimeline, { depth: Infinity });
    const tweets: TweetData[] = [];
    for (const tweet of homeTimeline.data.data) {
      const tweetUser = await this.fetchUser(tweet.author_id!);
      tweets.push({
        ...tweet,
        username: tweetUser.username,
        name: tweetUser.name,
      });
    }
    // const processedTimeline = homeTimeline.data.data
    //   .filter((t) => t.__typename !== 'TweetWithVisibilityResults') // what's this about?
    //   .map((tweet) => {
    //     //console.log("tweet is", tweet);
    //     const obj = {
    //       id: tweet.id,
    //       name: tweet.name ?? tweet?.user_results?.result?.legacy.name,
    //       username:
    //         tweet.username ??
    //         tweet.core?.user_results?.result?.legacy.screen_name,
    //       text: tweet.text ?? tweet.legacy?.full_text,
    //       inReplyToStatusId:
    //         tweet.inReplyToStatusId ??
    //         tweet.legacy?.in_reply_to_status_id_str ??
    //         null,
    //       timestamp: new Date(tweet.legacy?.created_at).getTime() / 1000,
    //       createdAt:
    //         tweet.createdAt ??
    //         tweet.legacy?.created_at ??
    //         tweet.core?.user_results?.result?.legacy.created_at,
    //       userId: tweet.userId ?? tweet.legacy?.user_id_str,
    //       conversationId:
    //         tweet.conversationId ?? tweet.legacy?.conversation_id_str,
    //       permanentUrl: `https://x.com/${tweet.core?.user_results?.result?.legacy?.screen_name}/status/${tweet.rest_id}`,
    //       hashtags: tweet.hashtags ?? tweet.legacy?.entities.hashtags,
    //       mentions: tweet.mentions ?? tweet.legacy?.entities.user_mentions,
    //       photos:
    //         tweet.photos ??
    //         tweet.legacy?.entities.media?.filter(
    //           (media) => media.type === 'photo',
    //         ) ??
    //         [],
    //       thread: tweet.thread || [],
    //       urls: tweet.urls ?? tweet.legacy?.entities.urls,
    //       videos:
    //         tweet.videos ??
    //         tweet.legacy?.entities.media?.filter(
    //           (media) => media.type === 'video',
    //         ) ??
    //         [],
    //     };
    //     //console.log("obj is", obj);
    //     return obj;
    //   });
    //elizaLogger.debug("process homeTimeline", processedTimeline);
    return tweets;
  }

  async fetchTimelineForActions(count: number): Promise<TweetData[]> {
    elizaLogger.debug("fetching timeline for actions");

    const agentId = this.profile!.id;
    const homeTimeline = await this.twitterClient.v2.homeTimeline({
      max_results: count,
      expansions: ["author_id", "in_reply_to_user_id"],
    });

    const tweets: TweetData[] = [];

    for (const tweet of homeTimeline.data.data) {
      const tweetUser = await this.fetchUser(tweet.author_id!);
      if (tweet.author_id !== agentId) {
        tweets.push({
          ...tweet,
          username: tweetUser.username,
          name: tweetUser.name,
        });
      }
    }

    return tweets; // do not perform action on self-tweets
  }

  async fetchSearchTweets(
    query: string,
    maxTweets: number,
    // searchMode: SearchMode,
    cursor?: string
  ): Promise<TweetData[]> {
    try {
      // Sometimes this fails because we are rate limited. in this case, we just need to return an empty array
      // if we dont get a response in 5 seconds, something is wrong
      const timeoutPromise = new Promise<TweetData[]>((resolve) =>
        setTimeout(() => resolve([]), 10000)
      );

      const searchTweets = async () => {
        const result = await this.twitterClient.v2.search(query, {
          max_results: maxTweets,
          next_token: cursor,
          expansions: ["author_id", "in_reply_to_user_id"],
        });

        const tweets: TweetData[] = [];
        for (const tweet of result.data.data) {
          const tweetUser = await this.fetchUser(tweet.author_id!);
          tweets.push({
            ...tweet,
            username: tweetUser.username,
            name: tweetUser.name,
          });
        }

        return tweets;
      };

      try {
        const result = await this.requestQueue.add(
          async () => await Promise.race([searchTweets(), timeoutPromise])
        );

        return result ?? [];
      } catch (error) {
        elizaLogger.error("Error fetching search tweets:", error);
        return [];
      }
    } catch (error) {
      elizaLogger.error("Error fetching search tweets:", error);
      return [];
    }
  }

  private async populateTimeline() {
    elizaLogger.debug("populating timeline...");

    const cachedTimeline = await this.getCachedTimeline();

    // Check if the cache file exists
    if (cachedTimeline) {
      // Read the cached search results from the file

      // Get the existing memories from the database
      const existingMemories =
        await this.runtime.messageManager.getMemoriesByRoomIds({
          roomIds: cachedTimeline.map((tweet) =>
            stringToUuid(tweet.conversation_id + "-" + this.runtime.agentId)
          ),
        });

      //TODO: load tweets not in cache?

      // Create a Set to store the IDs of existing memories
      const existingMemoryIds = new Set(
        existingMemories.map((memory) => memory.id!.toString())
      );

      // Check if any of the cached tweets exist in the existing memories
      const someCachedTweetsExist = cachedTimeline.some((tweet) =>
        existingMemoryIds.has(
          stringToUuid(tweet.id + "-" + this.runtime.agentId)
        )
      );

      if (someCachedTweetsExist) {
        // Filter out the cached tweets that already exist in the database
        const tweetsToSave = cachedTimeline.filter(
          (tweet) =>
            !existingMemoryIds.has(
              stringToUuid(tweet.id + "-" + this.runtime.agentId)
            )
        );

        console.log({
          processingTweets: tweetsToSave.map((tweet) => tweet.id).join(","),
        });

        // Save the missing tweets as memories
        for (const tweet of tweetsToSave) {
          elizaLogger.log("Saving Tweet", tweet.id);

          const roomId = stringToUuid(
            tweet.conversation_id + "-" + this.runtime.agentId
          );
          const user = await this.fetchProfile(tweet.author_id!);
          const userId =
            tweet.author_id === this.profile!.id
              ? this.runtime.agentId
              : stringToUuid(tweet.author_id!);

          if (tweet.author_id === this.profile!.id) {
            await this.runtime.ensureConnection(
              this.runtime.agentId,
              roomId,
              this.profile!.username,
              this.profile!.screenName,
              "twitter"
            );
          } else {
            await this.runtime.ensureConnection(
              userId,
              roomId,
              user.username,
              user.screenName,
              "twitter"
            );
          }

          const content = {
            text: tweet.text,
            url: `https://twitter.com/${user.username}/status/${tweet.id}`,
            source: "twitter",
            inReplyTo: tweet.in_reply_to_user_id
              ? stringToUuid(
                  tweet.in_reply_to_user_id + "-" + this.runtime.agentId
                )
              : undefined,
          } as Content;

          elizaLogger.log("Creating memory for tweet", tweet.id);

          // check if it already exists
          const memory = await this.runtime.messageManager.getMemoryById(
            stringToUuid(tweet.id + "-" + this.runtime.agentId)
          );

          if (memory) {
            elizaLogger.log(
              "Memory already exists, skipping timeline population"
            );
            break;
          }

          await this.runtime.messageManager.createMemory({
            id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
            userId,
            content: content,
            agentId: this.runtime.agentId,
            roomId,
            embedding: getEmbeddingZeroVector(),
            createdAt: new Date(tweet.created_at!).getTime(),
          });

          await this.cacheTweet(tweet);
        }

        elizaLogger.log(
          `Populated ${tweetsToSave.length} missing tweets from the cache.`
        );
        return;
      }
    }

    const timeline = await this.fetchHomeTimeline(cachedTimeline ? 10 : 50);
    const username = this.twitterConfig.TWITTER_USERNAME;

    // Get the most recent 20 mentions and interactions
    const mentionsAndInteractions = await this.fetchSearchTweets(
      `@${username}`,
      20
      // SearchMode.Latest,
    );

    // Combine the timeline tweets and mentions/interactions
    const allTweets = [...timeline, ...mentionsAndInteractions];

    // Create a Set to store unique tweet IDs
    const tweetIdsToCheck = new Set<string>();
    const roomIds = new Set<UUID>();

    // Add tweet IDs to the Set
    for (const tweet of allTweets) {
      tweetIdsToCheck.add(tweet.id);
      roomIds.add(
        stringToUuid(tweet.conversation_id + "-" + this.runtime.agentId)
      );
    }

    // Check the existing memories in the database
    const existingMemories =
      await this.runtime.messageManager.getMemoriesByRoomIds({
        roomIds: Array.from(roomIds),
      });

    // Create a Set to store the existing memory IDs
    const existingMemoryIds = new Set<UUID>(
      existingMemories.map((memory) => memory.id) as UUID[]
    );

    // Filter out the tweets that already exist in the database
    const tweetsToSave = allTweets.filter(
      (tweet) =>
        !existingMemoryIds.has(
          stringToUuid(tweet.id + "-" + this.runtime.agentId)
        )
    );

    elizaLogger.debug({
      processingTweets: tweetsToSave.map((tweet) => tweet.id).join(","),
    });

    await this.runtime.ensureUserExists(
      this.runtime.agentId,
      this.profile!.username,
      this.runtime.character.name,
      "twitter"
    );

    // Save the new tweets as memories
    for (const tweet of tweetsToSave) {
      elizaLogger.log("Saving Tweet", tweet.id);

      const roomId = stringToUuid(
        tweet.conversation_id + "-" + this.runtime.agentId
      );
      const userId =
        tweet.author_id === this.profile!.id
          ? this.runtime.agentId
          : stringToUuid(tweet.author_id!);
      const user = await this.fetchProfile(tweet.author_id!);
      if (tweet.author_id === this.profile!.id) {
        await this.runtime.ensureConnection(
          this.runtime.agentId,
          roomId,
          this.profile!.username,
          this.profile!.screenName,
          "twitter"
        );
      } else {
        await this.runtime.ensureConnection(
          userId,
          roomId,
          user.username,
          user.screenName,
          "twitter"
        );
      }

      const content = {
        text: tweet.text,
        url: `https://twitter.com/${user.username}/status/${tweet.id}`,
        source: "twitter",
        inReplyTo: tweet.in_reply_to_user_id
          ? stringToUuid(tweet.in_reply_to_user_id)
          : undefined,
      } as Content;

      await this.runtime.messageManager.createMemory({
        id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
        userId,
        content: content,
        agentId: this.runtime.agentId,
        roomId,
        embedding: getEmbeddingZeroVector(),
        createdAt: new Date(tweet.created_at!).getTime(),
      });

      await this.cacheTweet({
        ...tweet,
        username: user.username,
        name: user.screenName,
      });
    }

    const mentions: TweetData[] = [];

    for (const tweet of mentionsAndInteractions) {
      const tweetUser = await this.fetchUser(tweet.author_id!);
      mentions.push({
        ...tweet,
        username: tweetUser.username,
        name: tweetUser.name,
      });
    }

    // Cache
    await this.cacheTimeline(timeline);
    await this.cacheMentions(mentions);
  }

  async setCookiesFromArray(cookiesArray: any[]) {
    const cookieStrings = cookiesArray.map(
      (cookie) =>
        `${cookie.key}=${cookie.value}; Domain=${cookie.domain}; Path=${cookie.path}; ${
          cookie.secure ? "Secure" : ""
        }; ${cookie.httpOnly ? "HttpOnly" : ""}; SameSite=${
          cookie.sameSite || "Lax"
        }`
    );
    // await this.twitterClient.setCookies(cookieStrings);
  }

  async saveRequestMessage(message: Memory, state: State) {
    if (message.content.text) {
      const recentMessage = await this.runtime.messageManager.getMemories({
        roomId: message.roomId,
        count: 1,
        unique: false,
      });

      if (
        recentMessage.length > 0 &&
        recentMessage[0].content === message.content
      ) {
        elizaLogger.debug("Message already saved", recentMessage[0].id);
      } else {
        await this.runtime.messageManager.createMemory({
          ...message,
          embedding: getEmbeddingZeroVector(),
        });
      }

      await this.runtime.evaluate(message, {
        ...state,
        twitterClient: this.twitterClient,
      });
    }
  }

  async loadLatestCheckedTweetId(): Promise<void> {
    const latestCheckedTweetId = await this.runtime.cacheManager.get<string>(
      `twitter/${this.profile!.username}/latest_checked_tweet_id`
    );

    if (latestCheckedTweetId) {
      this.lastCheckedTweetId = BigInt(latestCheckedTweetId);
    }
  }

  async cacheLatestCheckedTweetId() {
    if (this.lastCheckedTweetId) {
      await this.runtime.cacheManager.set(
        `twitter/${this.profile!.username}/latest_checked_tweet_id`,
        this.lastCheckedTweetId.toString()
      );
    }
  }

  async getCachedTimeline(): Promise<TweetData[] | undefined> {
    return await this.runtime.cacheManager.get<TweetData[]>(
      `twitter/${this.profile!.username}/timeline`
    );
  }

  async cacheTimeline(timeline: TweetData[]) {
    await this.runtime.cacheManager.set(
      `twitter/${this.profile!.username}/timeline`,
      timeline,
      { expires: Date.now() + 10 * 1000 }
    );
  }

  async cacheMentions(mentions: TweetData[]) {
    await this.runtime.cacheManager.set(
      `twitter/${this.profile!.username}/mentions`,
      mentions,
      { expires: Date.now() + 10 * 1000 }
    );
  }

  async getCachedCookies(username: string) {
    return await this.runtime.cacheManager.get<any[]>(
      `twitter/${username}/cookies`
    );
  }

  async cacheCookies(username: string, cookies: any[]) {
    await this.runtime.cacheManager.set(`twitter/${username}/cookies`, cookies);
  }

  async getCachedProfile(username: string) {
    return await this.runtime.cacheManager.get<TwitterProfile>(
      `twitter/${username}/profile`
    );
  }

  async cacheProfile(profile: TwitterProfile) {
    await this.runtime.cacheManager.set(
      `twitter/${profile.username}/profile`,
      profile
    );
  }

  async fetchProfile(username: string): Promise<TwitterProfile> {
    const cached = await this.getCachedProfile(username);

    if (cached) return cached;

    try {
      const profile = await this.requestQueue.add(async () => {
        const { data: profile } =
          await this.twitterClient.v2.userByUsername(username);
        // console.log({ profile });
        return {
          id: profile.id,
          username,
          screenName: profile.name || this.runtime.character.name,
          bio: profile.description || this.runtime.character.description,
          nicknames: this.runtime.character.twitterProfile?.nicknames || [],
        } satisfies TwitterProfile;
      });

      this.cacheProfile(profile);

      return profile;
    } catch (error) {
      console.error("Error fetching Twitter profile:", error);
      throw error;
    }
  }

  fetchUser(id: string) {
    return this.requestQueue.add(async () => {
      const { data: user } = await this.twitterClient.v2.user(id);
      return user;
    });
  }
}
