import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LinearClient, ClientRegistry } from "../../src/linear-api.js";
import { createRelationTool } from "../../src/tools/linear-relation-tool.js";

function parse(result: { content: { type: string; text?: string }[] }) {
  const text = result.content.find((c) => c.type === "text")?.text;
  return text ? JSON.parse(text) : undefined;
}

function makeMockClient() {
  return {
    graphql: vi.fn(),
    resolveIssueId: vi.fn(),
  } as unknown as LinearClient & {
    graphql: ReturnType<typeof vi.fn>;
    resolveIssueId: ReturnType<typeof vi.fn>;
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

describe("linear_relation tool", () => {
  it("has correct name", () => {
    const tool = createRelationTool(registry);
    expect(tool.name).toBe("linear_relation");
  });

  describe("list", () => {
    it("returns relations and inverse relations", async () => {
      mockClient.resolveIssueId.mockResolvedValue("uuid-1");
      mockClient.graphql.mockResolvedValue({
        issue: {
          relations: {
            nodes: [
              {
                id: "r1",
                type: "blocks",
                relatedIssue: { identifier: "ENG-2", title: "Task 2" },
              },
            ],
          },
          inverseRelations: {
            nodes: [
              {
                id: "r2",
                type: "blocks",
                issue: { identifier: "ENG-3", title: "Task 3" },
              },
            ],
          },
        },
      });

      const tool = createRelationTool(registry);
      const result = await tool.execute("call-1", {
        action: "list",
        issueId: "ENG-1",
      });
      const data = parse(result);
      expect(data.relations).toHaveLength(2);
      expect(data.relations[0].issue.identifier).toBe("ENG-2");
      expect(data.relations[1].direction).toBe("inverse");
    });

    it("returns error without issueId", async () => {
      const tool = createRelationTool(registry);
      const result = await tool.execute("call-1", { action: "list" });
      const data = parse(result);
      expect(data.error).toContain("issueId is required");
    });
  });

  describe("add", () => {
    it("creates a blocks relation", async () => {
      mockClient.resolveIssueId
        .mockResolvedValueOnce("uuid-1")
        .mockResolvedValueOnce("uuid-2");
      mockClient.graphql.mockResolvedValue({
        issueRelationCreate: {
          success: true,
          issueRelation: { id: "r-new", type: "blocks" },
        },
      });

      const tool = createRelationTool(registry);
      const result = await tool.execute("call-1", {
        action: "add",
        issueId: "ENG-1",
        type: "blocks",
        relatedIssueId: "ENG-2",
      });
      const data = parse(result);
      expect(data.success).toBe(true);
    });

    it("swaps direction for blocked-by", async () => {
      mockClient.resolveIssueId
        .mockResolvedValueOnce("uuid-related") // relatedIssueId resolved first for blocked-by
        .mockResolvedValueOnce("uuid-issue");
      mockClient.graphql.mockResolvedValue({
        issueRelationCreate: {
          success: true,
          issueRelation: { id: "r-new", type: "blocks" },
        },
      });

      const tool = createRelationTool(registry);
      await tool.execute("call-1", {
        action: "add",
        issueId: "ENG-1",
        type: "blocked-by",
        relatedIssueId: "ENG-2",
      });

      // For blocked-by, issueId and relatedIssueId are swapped
      const call = mockClient.graphql.mock.calls[0];
      const vars = call[1] as {
        input: { issueId: string; relatedIssueId: string; type: string };
      };
      expect(vars.input.issueId).toBe("uuid-related");
      expect(vars.input.relatedIssueId).toBe("uuid-issue");
      expect(vars.input.type).toBe("blocks");
    });

    it("returns error without required fields", async () => {
      const tool = createRelationTool(registry);

      let result = await tool.execute("call-1", { action: "add" });
      expect(parse(result).error).toContain("issueId is required");

      result = await tool.execute("call-2", {
        action: "add",
        issueId: "ENG-1",
      });
      expect(parse(result).error).toContain("type is required");

      result = await tool.execute("call-3", {
        action: "add",
        issueId: "ENG-1",
        type: "blocks",
      });
      expect(parse(result).error).toContain("relatedIssueId is required");
    });
  });

  describe("delete", () => {
    it("deletes a relation", async () => {
      mockClient.graphql.mockResolvedValue({
        issueRelationDelete: { success: true },
      });

      const tool = createRelationTool(registry);
      const result = await tool.execute("call-1", {
        action: "delete",
        relationId: "r1",
      });
      const data = parse(result);
      expect(data.success).toBe(true);
    });

    it("returns error without relationId", async () => {
      const tool = createRelationTool(registry);
      const result = await tool.execute("call-1", { action: "delete" });
      const data = parse(result);
      expect(data.error).toContain("relationId is required");
    });
  });

  it("catches and returns API errors", async () => {
    mockClient.resolveIssueId.mockRejectedValue(new Error("Connection refused"));

    const tool = createRelationTool(registry);
    const result = await tool.execute("call-1", {
      action: "list",
      issueId: "ENG-1",
    });
    const data = parse(result);
    expect(data.error).toContain("Connection refused");
  });
});
