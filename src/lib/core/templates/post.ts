export const twitterPostTemplate = (userPrompt: string = "") => `
# About {{agentName}} (@{{twitterUserName}}):
{{description}}
{{goal}}

Recent tweets by {{agentName}}:
{{recentTweets}}

# Task: Generate a post in the voice and style and perspective of {{agentName}} @{{twitterUserName}}.
Write a post that is from the perspective of {{agentName}}. Do not add commentary or acknowledge this request, just write the post.
The post should be unique and not too similar to the recent tweets shown above.

Your response should be 1, 2, or 3 sentences (choose the length at random).
Your response should not contain any questions. Brief, concise statements only. The total character count MUST be less than {{maxTweetLength}}. No emojis. Use \\n\\n (double spaces) between statements if there are multiple statements in your response.

Here is additional prompt (if provided):
${userPrompt}
`;
