import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LinearClient, ClientRegistry } from "../../src/linear-api.js";
import { createProjectTool } from "../../src/tools/linear-project-tool.js";

function parse(result: { content: { type: string; text?: string }[] }) {
  const text = result.content.find((c) => c.type === "text")?.text;
  return text ? JSON.parse(text) : undefined;
}

function makeMockClient() {
  return {
    graphql: vi.fn(),
    resolveTeamId: vi.fn(),
  } as unknown as LinearClient & {
    graphql: ReturnType<typeof vi.fn>;
    resolveTeamId: ReturnType<typeof vi.fn>;
  };
}

function makeRegistry(client: LinearClient): ClientRegistry {
  return { get: () => client } as unknown as ClientRegistry;
}

let mockClient: ReturnType<typeof makeMockClient>;
let registry: ClientRegistry;

beforeEach(() => {
  vi.clearAllMocks();
  mockClient = makeMockClient();
  registry = makeRegistry(mockClient);
});

describe("linear_project tool", () => {
  it("has correct name", () => {
    const tool = createProjectTool(registry);
    expect(tool.name).toBe("linear_project");
  });

  describe("list", () => {
    it("returns projects", async () => {
      mockClient.graphql.mockResolvedValue({
        projects: {
          nodes: [
            {
              id: "p1",
              name: "Alpha",
              status: { name: "Started", type: "started" },
              teams: { nodes: [{ name: "Eng", key: "ENG" }] },
            },
          ],
        },
      });

      const tool = createProjectTool(registry);
      const result = await tool.execute("call-1", { action: "list" });
      const data = parse(result);
      expect(data.projects).toHaveLength(1);
      expect(data.projects[0].name).toBe("Alpha");
    });

    it("applies filters", async () => {
      mockClient.graphql.mockResolvedValue({
        projects: { nodes: [] },
      });

      const tool = createProjectTool(registry);
      await tool.execute("call-1", {
        action: "list",
        team: "ENG",
        status: "planned",
      });

      const query = mockClient.graphql.mock.calls[0][0] as string;
      expect(query).toContain("status:");
      expect(query).toContain("$status");
      expect(query).toContain("$team");
    });
  });

  describe("view", () => {
    it("returns project details", async () => {
      mockClient.graphql.mockResolvedValue({
        project: {
          id: "p1",
          name: "Alpha",
          description: "Main project",
          status: { name: "Started", type: "started" },
        },
      });

      const tool = createProjectTool(registry);
      const result = await tool.execute("call-1", {
        action: "view",
        projectId: "p1",
      });
      const data = parse(result);
      expect(data.name).toBe("Alpha");
    });

    it("returns error without projectId", async () => {
      const tool = createProjectTool(registry);
      const result = await tool.execute("call-1", { action: "view" });
      const data = parse(result);
      expect(data.error).toContain("projectId is required");
    });
  });

  describe("create", () => {
    it("creates a project", async () => {
      mockClient.resolveTeamId.mockResolvedValue("team-1");
      mockClient.graphql.mockResolvedValue({
        projectCreate: {
          success: true,
          project: { id: "p-new", name: "Beta", url: "https://linear.app/p" },
        },
      });

      const tool = createProjectTool(registry);
      const result = await tool.execute("call-1", {
        action: "create",
        name: "Beta",
        team: "ENG",
        description: "New project",
      });
      const data = parse(result);
      expect(data.success).toBe(true);
      expect(data.project.name).toBe("Beta");
    });

    it("returns error without name", async () => {
      const tool = createProjectTool(registry);
      const result = await tool.execute("call-1", { action: "create" });
      const data = parse(result);
      expect(data.error).toContain("name is required");
    });
  });

  it("catches and returns API errors", async () => {
    mockClient.graphql.mockRejectedValue(new Error("Timeout"));

    const tool = createProjectTool(registry);
    const result = await tool.execute("call-1", { action: "list" });
    const data = parse(result);
    expect(data.error).toContain("Timeout");
  });
});
