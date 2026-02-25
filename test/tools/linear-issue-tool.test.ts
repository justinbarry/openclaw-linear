import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LinearClient, ClientRegistry } from "../../src/linear-api.js";
import { createIssueTool } from "../../src/tools/linear-issue-tool.js";

function parse(result: { content: { type: string; text?: string }[] }) {
  const text = result.content.find((c) => c.type === "text")?.text;
  return text ? JSON.parse(text) : undefined;
}

function makeMockClient() {
  return {
    graphql: vi.fn(),
    resolveIssueId: vi.fn(),
    resolveTeamId: vi.fn(),
    resolveStateId: vi.fn(),
    resolveUserId: vi.fn(),
    resolveLabelIds: vi.fn(),
    resolveProjectId: vi.fn(),
  } as unknown as LinearClient & {
    graphql: ReturnType<typeof vi.fn>;
    resolveIssueId: ReturnType<typeof vi.fn>;
    resolveTeamId: ReturnType<typeof vi.fn>;
    resolveStateId: ReturnType<typeof vi.fn>;
    resolveUserId: ReturnType<typeof vi.fn>;
    resolveLabelIds: ReturnType<typeof vi.fn>;
    resolveProjectId: ReturnType<typeof vi.fn>;
  };
}

function makeRegistry(client: LinearClient): ClientRegistry {
  return {
    get: () => client,
    names: () => ["default"],
    defaultWorkspace: () => "default",
    size: () => 1,
  } as unknown as ClientRegistry;
}

let mockClient: ReturnType<typeof makeMockClient>;
let registry: ClientRegistry;

beforeEach(() => {
  vi.clearAllMocks();
  mockClient = makeMockClient();
  registry = makeRegistry(mockClient);
});

describe("linear_issue tool", () => {
  it("has correct name", () => {
    const tool = createIssueTool(registry);
    expect(tool.name).toBe("linear_issue");
  });

  describe("view", () => {
    it("returns issue details", async () => {
      mockClient.resolveIssueId.mockResolvedValue("uuid-1");
      const issue = {
        id: "uuid-1",
        identifier: "ENG-42",
        title: "Fix bug",
        state: { name: "Todo" },
      };
      mockClient.graphql.mockResolvedValue({ issue });

      const tool = createIssueTool(registry);
      const result = await tool.execute("call-1", {
        action: "view",
        issueId: "ENG-42",
      });
      const data = parse(result);
      expect(data.identifier).toBe("ENG-42");
      expect(data.title).toBe("Fix bug");
    });

    it("returns error without issueId", async () => {
      const tool = createIssueTool(registry);
      const result = await tool.execute("call-1", { action: "view" });
      const data = parse(result);
      expect(data.error).toContain("issueId is required");
    });
  });

  describe("list", () => {
    it("returns filtered issues", async () => {
      mockClient.graphql.mockResolvedValue({
        issues: {
          nodes: [
            { id: "i1", identifier: "ENG-1", title: "Task 1" },
            { id: "i2", identifier: "ENG-2", title: "Task 2" },
          ],
        },
      });

      const tool = createIssueTool(registry);
      const result = await tool.execute("call-1", {
        action: "list",
        state: "In Progress",
        team: "ENG",
      });
      const data = parse(result);
      expect(data.issues).toHaveLength(2);
    });

    it("lists without filters", async () => {
      mockClient.graphql.mockResolvedValue({
        issues: { nodes: [] },
      });

      const tool = createIssueTool(registry);
      const result = await tool.execute("call-1", { action: "list" });
      const data = parse(result);
      expect(data.issues).toEqual([]);
    });
  });

  describe("create", () => {
    it("creates an issue with all fields", async () => {
      mockClient.resolveTeamId.mockResolvedValue("team-1");
      mockClient.resolveStateId.mockResolvedValue("state-1");
      mockClient.resolveUserId.mockResolvedValue("user-1");
      mockClient.resolveProjectId.mockResolvedValue("proj-1");
      mockClient.resolveIssueId.mockResolvedValue("parent-uuid");
      mockClient.resolveLabelIds.mockResolvedValue(["label-1"]);
      mockClient.graphql.mockResolvedValue({
        issueCreate: {
          success: true,
          issue: {
            id: "new-id",
            identifier: "ENG-100",
            url: "https://linear.app/eng/issue/ENG-100",
            title: "New issue",
          },
        },
      });

      const tool = createIssueTool(registry);
      const result = await tool.execute("call-1", {
        action: "create",
        title: "New issue",
        description: "Details",
        team: "ENG",
        state: "Todo",
        assignee: "Alice",
        project: "Alpha",
        parent: "ENG-50",
        labels: ["Bug"],
        priority: 2,
      });
      const data = parse(result);
      expect(data.success).toBe(true);
      expect(data.issue.identifier).toBe("ENG-100");
    });

    it("returns error without title", async () => {
      const tool = createIssueTool(registry);
      const result = await tool.execute("call-1", { action: "create" });
      const data = parse(result);
      expect(data.error).toContain("title is required");
    });

    it("fetches default team when none specified", async () => {
      mockClient.graphql
        .mockResolvedValueOnce({ teams: { nodes: [{ id: "default-team" }] } })
        .mockResolvedValueOnce({
          issueCreate: {
            success: true,
            issue: { id: "x", identifier: "T-1", url: "u", title: "T" },
          },
        });

      const tool = createIssueTool(registry);
      const result = await tool.execute("call-1", {
        action: "create",
        title: "Minimal",
      });
      const data = parse(result);
      expect(data.success).toBe(true);
    });
  });

  describe("update", () => {
    it("updates issue fields", async () => {
      mockClient.resolveIssueId.mockResolvedValue("uuid-1");
      mockClient.graphql
        .mockResolvedValueOnce({ issue: { team: { id: "team-1" } } })
        .mockResolvedValueOnce({
          issueUpdate: {
            success: true,
            issue: { id: "uuid-1", identifier: "ENG-42", title: "Updated" },
          },
        });
      mockClient.resolveStateId.mockResolvedValue("state-done");

      const tool = createIssueTool(registry);
      const result = await tool.execute("call-1", {
        action: "update",
        issueId: "ENG-42",
        state: "Done",
        title: "Updated",
      });
      const data = parse(result);
      expect(data.success).toBe(true);
    });

    it("returns error without issueId", async () => {
      const tool = createIssueTool(registry);
      const result = await tool.execute("call-1", {
        action: "update",
        title: "No ID",
      });
      const data = parse(result);
      expect(data.error).toContain("issueId is required");
    });
  });

  describe("delete", () => {
    it("deletes an issue", async () => {
      mockClient.resolveIssueId.mockResolvedValue("uuid-1");
      mockClient.graphql.mockResolvedValue({
        issueDelete: { success: true },
      });

      const tool = createIssueTool(registry);
      const result = await tool.execute("call-1", {
        action: "delete",
        issueId: "ENG-42",
      });
      const data = parse(result);
      expect(data.success).toBe(true);
    });

    it("returns error without issueId", async () => {
      const tool = createIssueTool(registry);
      const result = await tool.execute("call-1", { action: "delete" });
      const data = parse(result);
      expect(data.error).toContain("issueId is required");
    });
  });

  it("catches and returns errors from the API", async () => {
    mockClient.resolveIssueId.mockRejectedValue(new Error("Network failure"));

    const tool = createIssueTool(registry);
    const result = await tool.execute("call-1", {
      action: "view",
      issueId: "ENG-1",
    });
    const data = parse(result);
    expect(data.error).toContain("Network failure");
  });
});
