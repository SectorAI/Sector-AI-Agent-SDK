import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { ChildProcess, spawn } from "child_process";
import path, { dirname } from "path";
import { fileURLToPath } from "url";
import { env } from "./config/index.js";
import {
  AgentStatus,
  GetAgentStatusRequest,
  SimulateAgentRequest,
  SimulateAgentResponse,
  StartAgentRequest,
  StartAgentResponse,
  StopAgentRequest,
  StopAgentResponse,
} from "./gen/agent_manager_pb.js";
import { Character } from "./interfaces/character.js";
import { generateReply, generateTweet } from "./lib/core/simulate.js";
import { createRuntime } from "./lib/utils.js";

interface AgentRegistry {
  [pid: string]: { process: ChildProcess; status: string };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const agents: AgentRegistry = {};

const PROTO_PATH = path.resolve(__dirname, "../proto/agent_manager.proto");
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const agentProto = grpc.loadPackageDefinition(packageDefinition) as any;

const simulateAgent = async (
  call: grpc.ServerUnaryCall<SimulateAgentRequest, SimulateAgentResponse>,
  callback: grpc.sendUnaryData<any>
) => {
  const { character, action, tweet } = call.request;

  if (!character) {
    callback({
      message: "Missing 'character' parameter.",
      code: grpc.status.INVALID_ARGUMENT,
      name: "MissingRequiredParametersError",
    });
    return;
  }
  let parsedCharacter: Character;
  try {
    parsedCharacter = JSON.parse(character);
  } catch (error) {
    console.warn("Error parsing character from environment variables:", error);

    callback({
      message: "Invalid CHARACTER.",
      name: "InvalidCharacterError",
      code: grpc.status.INVALID_ARGUMENT,
    });
    return;
  }

  const runtime = await createRuntime(parsedCharacter);

  await runtime.initialize();
  console.log("Runtime initialized.");
  console.log(action);

  if (action.toString() === "TWEET") {
    console.log("Generating tweet...");

    try {
      const response = await generateTweet(runtime);

      callback(null, { response });
      return;
    } catch (error) {
      console.error("Error generating tweet:", error);
      callback({
        message: "Error generating tweet.",
        name: "GenerateTweetError",
        code: grpc.status.INTERNAL,
      });
      return;
    }
  }

  if (action.toString() === "REPLY") {
    if (!tweet) {
      callback({
        message: "Missing 'tweet' parameter.",
        code: grpc.status.INVALID_ARGUMENT,
        name: "MissingRequiredParametersError",
      });
      return;
    }

    try {
      const response = await generateReply(runtime, tweet);
      callback(null, { response });
      return;
    } catch (error) {
      console.error("Error generating reply:", JSON.stringify(error));
      callback({
        message: "Error generating tweet.",
        name: "GenerateTweetError",
        code: grpc.status.INTERNAL,
      });
      return;
    }
  }

  await runtime.stop();

  callback({
    message: "Invalid action.",
    code: grpc.status.INVALID_ARGUMENT,
    name: "InvalidActionError",
  });
};

const startAgent = (
  call: grpc.ServerUnaryCall<StartAgentRequest, StartAgentResponse>,
  callback: grpc.sendUnaryData<any>
) => {
  const { character, twitter } = call.request;

  if (
    !character ||
    !twitter ||
    !twitter.username ||
    !twitter.token ||
    !twitter.secret
  ) {
    callback({
      message: "Missing required parameters.",
      code: grpc.status.INVALID_ARGUMENT,
      name: "MissingRequiredParametersError",
    });
    return;
  }

  const child = spawn("node", [path.resolve(__dirname, "agent.js")], {
    env: {
      ...process.env,
      CHARACTER: character,
      TWITTER_USERNAME: twitter.username,
      TWITTER_ACCESS_TOKEN: twitter.token,
      TWITTER_ACCESS_SECRET: twitter.secret,
    },
    stdio: ["pipe", "pipe", "pipe", "ipc"], // Enable IPC
    detached: true,
  });

  child.on("exit", (code) => {
    console.log(`Agent (PID: ${child.pid}) exited with code ${code}`);
    if (agents[child.pid]) {
      agents[child.pid].status = "stopped";
    }
  });

  // Unreference the child process so it doesn't keep the parent process alive
  child.unref();

  // Handle parent exit and clean up child process
  process.on("exit", () => {
    if (child.pid) {
      process.kill(-child.pid); // Kill the child process group
    }
  });

  process.on("SIGTERM", () => {
    process.exit(0); // Exit gracefully on termination signal
  });

  child.stdout?.on("data", (data) => {
    console.log(`Agent (PID: ${child.pid}) stdout: ${data}`);
  });

  child.stderr?.on("data", (data) => {
    console.error(`Agent (PID: ${child.pid}) stderr: ${data}`);
  });

  agents[child.pid] = { process: child, status: "running" };

  callback(null, { pid: String(child.pid) });
};

const stopAgent = (
  call: grpc.ServerUnaryCall<StopAgentRequest, StopAgentResponse>,
  callback: grpc.sendUnaryData<any>
) => {
  const { pid } = call.request;

  const agent = agents[pid];
  if (agent) {
    agent.process.kill();
    agent.status = "stopped";
    callback(null, { success: true });
  } else {
    callback({
      message: "Agent not found",
      code: grpc.status.NOT_FOUND,
      name: "AgentNotFoundError",
    });
  }
};

const getAgentStatus = (
  call: grpc.ServerUnaryCall<GetAgentStatusRequest, AgentStatus>,
  callback: grpc.sendUnaryData<any>
) => {
  const { pid } = call.request;

  const agent = agents[pid];
  if (agent) {
    callback(null, { pid, status: agent.status });
  } else {
    callback({
      message: "Agent not found",
      code: grpc.status.NOT_FOUND,
      name: "AgentNotFoundError",
    });
  }
};

const main = () => {
  const server = new grpc.Server();

  server.addService(agentProto.AgentManager.service, {
    SimulateAgent: simulateAgent,
    StartAgent: startAgent,
    StopAgent: stopAgent,
    GetAgentStatus: getAgentStatus,
  });

  server.bindAsync(
    `0.0.0.0:${env.port}`,
    grpc.ServerCredentials.createInsecure(),
    (err, boundPort) => {
      if (err) {
        console.error(err);
        return;
      }
      console.log(`Server running at 0.0.0.0:${boundPort}`);
    }
  );
};

main();
