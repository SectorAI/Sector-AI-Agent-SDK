import { IAgentRuntime as IAgentRuntimeBase } from "@elizaos/core";
import { Character } from "./character.js";

export interface IAgentRuntime extends Omit<IAgentRuntimeBase, "character"> {
  character: Character;
}
