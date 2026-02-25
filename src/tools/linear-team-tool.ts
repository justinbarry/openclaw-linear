import { Type, type Static } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { jsonResult, stringEnum, formatErrorMessage } from "openclaw/plugin-sdk";
import type { ClientRegistry, LinearClient } from "../linear-api.js";

const Params = Type.Object({
  action: stringEnum(
    ["list", "members"] as const,
    {
      description:
        "list: get all teams. " +
        "members: get members of a specific team.",
    },
  ),
  team: Type.Optional(
    Type.String({
      description: "Team key (e.g. ENG). Required for members.",
    }),
  ),
  workspace: Type.Optional(
    Type.String({
      description:
        "Workspace name to use (from plugin config). Defaults to the first configured workspace.",
    }),
  ),
});
type Params = Static<typeof Params>;

export function createTeamTool(registry: ClientRegistry): AnyAgentTool {
  return {
    name: "linear_team",
    label: "Linear Team",
    description: "View Linear teams and their members. Actions: list, members.",
    parameters: Params,
    async execute(_toolCallId: string, params: Params) {
      try {
        const client = registry.get(params.workspace);
        switch (params.action) {
          case "list":
            return await listTeams(client);
          case "members":
            return await listMembers(client, params);
          default:
            return jsonResult({
              error: `Unknown action: ${(params as { action: string }).action}`,
            });
        }
      } catch (err) {
        return jsonResult({
          error: `linear_team error: ${formatErrorMessage(err)}`,
        });
      }
    },
  };
}

async function listTeams(client: LinearClient) {
  const data = await client.graphql<{
    teams: {
      nodes: { id: string; name: string; key: string }[];
    };
  }>(`{ teams { nodes { id name key } } }`);

  return jsonResult({ teams: data.teams.nodes });
}

async function listMembers(client: LinearClient, params: Params) {
  if (!params.team) {
    return jsonResult({ error: "team is required for members" });
  }

  const data = await client.graphql<{
    teams: {
      nodes: {
        members: {
          nodes: { id: string; name: string; email: string }[];
        };
      }[];
    };
  }>(
    `query($key: String!) {
      teams(filter: { key: { eq: $key } }) {
        nodes {
          members {
            nodes { id name email }
          }
        }
      }
    }`,
    { key: params.team.toUpperCase() },
  );

  if (data.teams.nodes.length === 0) {
    return jsonResult({ error: `Team "${params.team}" not found` });
  }

  return jsonResult({ members: data.teams.nodes[0].members.nodes });
}
