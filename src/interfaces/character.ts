import { ModelConfiguration, ModelProviderName, UUID } from "@elizaos/core";

type Action = "POST" | "REPLY" | "QUOTE";

/**
 * Configuration for an agent character
 */
export type Character = {
  /** Optional unique identifier */
  id: UUID;

  /** Character name */
  name: string;

  /** Optional ticker */
  ticker?: string;

  /** Optional system prompt */
  worldInfo?: string;

  /** Character biography */
  description: string;

  /** Character goal */
  goal: string;

  /** Model provider to use */
  modelProvider: ModelProviderName;

  /** Image model provider to use, if different from modelProvider */
  imageModelProvider?: ModelProviderName;

  /** Image Vision model provider to use, if different from modelProvider */
  imageVisionModelProvider?: ModelProviderName;

  /** Optional model endpoint override */
  modelEndpointOverride?: string;

  /** Optional monitored accounts */
  monitoredAccounts?: {
    username: string;
    reason: string;
  }[];

  promptConfig: {
    [K in Action]: PromptConfig;
  };

  /** Optional configuration */
  settings?: {
    secrets?: { [key: string]: string };
  };

  /** Optional Twitter profile/ will update one logged in */
  twitterProfile?: {
    id: string;
    username: string;
    screenName: string;
    bio: string;
    nicknames?: string[];
  };
};

interface PromptConfig {
  userPrompt: string;
  modelConfig?: ModelConfiguration;
  intervalMin?: number;
  intervalMax?: number;
}
