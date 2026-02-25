import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { formatErrorMessage } from "openclaw/plugin-sdk";
import { createWebhookHandler } from "./webhook-handler.js";
import { createEventRouter, type RouterAction } from "./event-router.js";
import { InboxQueue, type EnqueueEntry } from "./work-queue.js";
import { createQueueTool, type QueueResolver } from "./tools/queue-tool.js";
import { ClientRegistry, setRegistry } from "./linear-api.js";
import { createIssueTool } from "./tools/linear-issue-tool.js";
import { createCommentTool } from "./tools/linear-comment-tool.js";
import { createTeamTool } from "./tools/linear-team-tool.js";
import { createProjectTool } from "./tools/linear-project-tool.js";
import { createRelationTool } from "./tools/linear-relation-tool.js";

const CHANNEL_ID = "linear";
const DEFAULT_DEBOUNCE_MS = 30_000;

const EVENT_LABELS: Record<string, string> = {
  "issue.assigned": "Assigned",
  "issue.unassigned": "Unassigned",
  "issue.reassigned": "Reassigned",
  "issue.removed": "Removed",
  "issue.state_removed": "State Removed",
  "issue.state_readded": "State Re-added",
  "issue.priority_changed": "Priority Changed",
  "comment.mention": "Mentioned",
};

export function formatConsolidatedMessage(actions: RouterAction[]): string {
  if (actions.length === 1) {
    return actions[0].detail;
  }

  const lines = actions.map((a, i) => {
    const label = EVENT_LABELS[a.event] ?? a.event;
    const summary = formatActionSummary(a);
    return `${i + 1}. [${label}] ${summary}`;
  });

  return `You have ${actions.length} new Linear notifications:\n\n${lines.join("\n")}\n\nReview and prioritize before starting work.`;
}

function formatActionSummary(action: RouterAction): string {
  if (action.event === "comment.mention") {
    const bodyStart = action.detail.indexOf("\n\n> ");
    if (bodyStart !== -1) {
      const quote = action.detail.slice(bodyStart + 4); // skip "\n\n> "
      return `${action.issueLabel}: "${quote}"`;
    }
  }

  return action.issueLabel || action.detail;
}

// ---------------------------------------------------------------------------
// Workspace config types
// ---------------------------------------------------------------------------

interface WorkspaceConfig {
  apiKey: string;
  webhookSecret: string;
  agentMapping?: Record<string, string>;
  teamIds?: string[];
  eventFilter?: string[];
  debounceMs?: number;
  stateActions?: Record<string, string>;
}

/** Parse plugin config into a map of workspace name → config.
 *  Supports both the legacy flat config and the new `workspaces` map. */
function parseWorkspaces(
  pluginConfig: Record<string, unknown>,
): Map<string, WorkspaceConfig> {
  const workspaces = new Map<string, WorkspaceConfig>();

  const raw = pluginConfig["workspaces"];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    // New multi-workspace config
    for (const [name, ws] of Object.entries(raw as Record<string, Record<string, unknown>>)) {
      const apiKey = ws["apiKey"] as string | undefined;
      const webhookSecret = ws["webhookSecret"] as string | undefined;
      if (!apiKey || !webhookSecret) continue;
      workspaces.set(name, {
        apiKey,
        webhookSecret,
        agentMapping: (ws["agentMapping"] as Record<string, string>) ?? {},
        teamIds: (ws["teamIds"] as string[]) ?? [],
        eventFilter: (ws["eventFilter"] as string[]) ?? [],
        debounceMs: ws["debounceMs"] as number | undefined,
        stateActions: (ws["stateActions"] as Record<string, string>) ?? undefined,
      });
    }
  }

  // Legacy flat config (single workspace named "default")
  if (workspaces.size === 0) {
    const apiKey = pluginConfig["apiKey"] as string | undefined;
    const webhookSecret = pluginConfig["webhookSecret"] as string | undefined;
    if (apiKey && webhookSecret) {
      workspaces.set("default", {
        apiKey,
        webhookSecret,
        agentMapping: (pluginConfig["agentMapping"] as Record<string, string>) ?? {},
        teamIds: (pluginConfig["teamIds"] as string[]) ?? [],
        eventFilter: (pluginConfig["eventFilter"] as string[]) ?? [],
        debounceMs: pluginConfig["debounceMs"] as number | undefined,
        stateActions: (pluginConfig["stateActions"] as Record<string, string>) ?? undefined,
      });
    }
  }

  return workspaces;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function dispatchConsolidatedActions(
  actions: RouterAction[],
  api: OpenClawPluginApi,
  queue: InboxQueue,
): Promise<void> {
  if (actions.length === 0) return;

  const core = api.runtime;
  const cfg = api.config;

  const first = actions[0];

  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: "default",
    peer: {
      kind: "direct" as const,
      id: first.linearUserId,
    },
  });

  // Write to queue deterministically — no LLM involved
  const entries: EnqueueEntry[] = actions.map((a) => ({
    id: a.commentId || a.identifier,
    issueId: a.identifier,
    event: a.event,
    summary: a.issueLabel,
    issuePriority: a.issuePriority,
  }));
  const added = await queue.enqueue(entries);

  if (added === 0) {
    api.logger.info("[linear] All notifications deduped — skipping agent dispatch");
    return;
  }

  // Agent gets a minimal notification pointing to the linear_queue tool
  const body = `${added} new Linear notification(s) queued. Use the linear_queue tool to process them.`;

  const ctx = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: body,
    RawBody: body,
    CommandBody: body,
    From: `${CHANNEL_ID}:${first.linearUserId}`,
    To: `${CHANNEL_ID}:${route.agentId ?? first.agentId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId ?? "default",
    ChatType: "direct",
    ConversationLabel: `Linear: batch (${actions.length} events)`,
    SenderId: first.linearUserId,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `${CHANNEL_ID}:${first.linearUserId}`,
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx,
    cfg,
    dispatcherOptions: {
      deliver: async () => {
        // No-op: agent uses Linear tools to respond to specific issues after triage
      },
      onError: (err: unknown) => {
        api.logger.error(
          `[linear] Reply error: ${formatErrorMessage(err)}`,
        );
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Plugin lifecycle
// ---------------------------------------------------------------------------

let activeDebouncer: { flushKey: (key: string) => Promise<void> } | undefined;
const activeDebouncerKeys = new Set<string>();

export function activate(api: OpenClawPluginApi): void {
  api.logger.info("Linear plugin activated");

  const pluginConfig = (api.pluginConfig ?? {}) as Record<string, unknown>;
  const workspaces = parseWorkspaces(pluginConfig);

  if (workspaces.size === 0) {
    api.logger.error("[linear] No workspaces configured (need apiKey + webhookSecret) — plugin is inert");
    return;
  }

  // --- Build client registry ---
  const registry = new ClientRegistry();
  for (const [name, ws] of workspaces) {
    registry.register(name, ws.apiKey);
  }
  setRegistry(registry);

  api.logger.info(
    `[linear] ${workspaces.size} workspace(s) configured: ${[...workspaces.keys()].join(", ")}`,
  );

  // --- Build per-workspace queues ---
  const queues = new Map<string, InboxQueue>();
  for (const name of workspaces.keys()) {
    const queuePath =
      workspaces.size === 1
        ? api.resolvePath("queue/inbox.jsonl")
        : api.resolvePath(`queue/${name}/inbox.jsonl`);
    queues.set(name, new InboxQueue(queuePath));
  }

  // Queue resolver for the tool
  const resolveQueue: QueueResolver = (workspace?: string) => {
    if (!workspace) {
      // Default to first workspace
      const first = queues.values().next().value;
      if (!first) throw new Error("No queues configured");
      return first;
    }
    const q = queues.get(workspace);
    if (!q) {
      const available = [...queues.keys()].join(", ");
      throw new Error(`Unknown workspace "${workspace}". Available: ${available}`);
    }
    return q;
  };

  // Recover stale in_progress items from all queues
  for (const [name, queue] of queues) {
    queue.recover().then((count) => {
      if (count > 0) {
        api.logger.info(`[linear:${name}] Recovered ${count} stale in_progress queue item(s)`);
      }
    }).catch((err) => {
      api.logger.error(
        `[linear:${name}] Queue recovery failed: ${formatErrorMessage(err)}`,
      );
    });
  }

  // --- Register tools (once, workspace-aware) ---
  api.registerTool(createQueueTool(resolveQueue));
  api.registerTool(createIssueTool(registry));
  api.registerTool(createCommentTool(registry));
  api.registerTool(createTeamTool(registry));
  api.registerTool(createProjectTool(registry));
  api.registerTool(createRelationTool(registry));

  const core = api.runtime;
  const cfg = api.config;

  // Auto-wake: after a "complete" action, dispatch a fresh session if items remain
  api.on("after_tool_call", async (event) => {
    if (event.toolName !== "linear_queue") return;
    if (event.params.action !== "complete") return;
    if (event.error) return;

    // Check all queues for remaining items
    let totalRemaining = 0;
    for (const queue of queues.values()) {
      const remaining = await queue.peek();
      totalRemaining += remaining.length;
    }
    if (totalRemaining === 0) return;

    const peerId = `queue-wake-${Date.now()}`;
    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: CHANNEL_ID,
      accountId: "default",
      peer: { kind: "direct" as const, id: peerId },
    });

    const body = `${totalRemaining} item(s) remaining in queue. Use the linear_queue tool to continue processing.`;

    const ctx = core.channel.reply.finalizeInboundContext({
      Body: body,
      BodyForAgent: body,
      RawBody: body,
      CommandBody: body,
      From: `${CHANNEL_ID}:${peerId}`,
      To: `${CHANNEL_ID}:${route.agentId ?? "default"}`,
      SessionKey: route.sessionKey,
      AccountId: route.accountId ?? "default",
      ChatType: "direct",
      ConversationLabel: `Linear: queue check (${totalRemaining} remaining)`,
      SenderId: peerId,
      Provider: CHANNEL_ID,
      Surface: CHANNEL_ID,
      OriginatingChannel: CHANNEL_ID,
      OriginatingTo: `${CHANNEL_ID}:${peerId}`,
    });

    core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx,
      cfg,
      dispatcherOptions: {
        deliver: async () => {},
        onError: (err: unknown) => {
          api.logger.error(
            `[linear] Queue wake error: ${formatErrorMessage(err)}`,
          );
        },
      },
    }).catch((err) => {
      api.logger.error(
        `[linear] Queue wake dispatch failed: ${formatErrorMessage(err)}`,
      );
    });
  });

  // --- Per-workspace webhook + event routing ---
  // Use a shared debouncer across all workspaces (keyed by agentId)
  const rawDebounceMs = pluginConfig["debounceMs"] as number | undefined;
  const globalDebounceMs =
    (typeof rawDebounceMs === "number" && rawDebounceMs > 0)
      ? rawDebounceMs
      : DEFAULT_DEBOUNCE_MS;

  // Collect all queues that a debounced action should flush to
  // We key debounce by agentId; action carries workspaceName to pick the right queue
  type WorkspaceAction = RouterAction & { workspaceName: string };

  const debouncer = api.runtime.channel.debounce.createInboundDebouncer<WorkspaceAction>({
    debounceMs: globalDebounceMs,
    buildKey: (action) => action.agentId,
    shouldDebounce: () => true,
    onFlush: async (actions) => {
      // Group actions by workspace and dispatch each group to its own queue
      const byWorkspace = new Map<string, WorkspaceAction[]>();
      for (const a of actions) {
        const list = byWorkspace.get(a.workspaceName) ?? [];
        list.push(a);
        byWorkspace.set(a.workspaceName, list);
      }
      for (const [wsName, wsActions] of byWorkspace) {
        const queue = queues.get(wsName);
        if (queue) {
          await dispatchConsolidatedActions(wsActions, api, queue);
        }
      }
    },
    onError: (err) => {
      api.logger.error(
        `[linear] Debounce flush failed: ${formatErrorMessage(err)}`,
      );
    },
  });
  activeDebouncer = debouncer;

  for (const [wsName, wsConfig] of workspaces) {
    const agentMapping = wsConfig.agentMapping ?? {};
    if (Object.keys(agentMapping).length === 0) {
      api.logger.info(`[linear:${wsName}] agentMapping is empty — webhook events will be dropped`);
    }

    const debounceMs =
      (typeof wsConfig.debounceMs === "number" && wsConfig.debounceMs > 0)
        ? wsConfig.debounceMs
        : globalDebounceMs;

    const routeEvent = createEventRouter({
      agentMapping,
      logger: api.logger,
      eventFilter: wsConfig.eventFilter?.length ? wsConfig.eventFilter : undefined,
      teamIds: wsConfig.teamIds?.length ? wsConfig.teamIds : undefined,
      stateActions: wsConfig.stateActions,
    });

    const queue = queues.get(wsName)!;

    const handler = createWebhookHandler({
      webhookSecret: wsConfig.webhookSecret,
      logger: api.logger,
      onEvent: (event) => {
        const actions = routeEvent(event);
        for (const action of actions) {
          api.logger.info(
            `[linear:${wsName}] ${action.type} agent=${action.agentId} event=${action.event}: ${action.detail}`,
          );

          if (action.type === "wake") {
            activeDebouncerKeys.add(action.agentId);
            debouncer.enqueue({ ...action, workspaceName: wsName });
          }

          if (action.type === "notify") {
            queue
              .enqueue([
                {
                  id: action.commentId || action.identifier,
                  issueId: action.identifier,
                  event: action.event,
                  summary: action.issueLabel,
                  issuePriority: action.issuePriority,
                },
              ])
              .catch((err) =>
                api.logger.error(
                  `[linear:${wsName}] Notify enqueue error: ${formatErrorMessage(err)}`,
                ),
              );
          }
        }
      },
    });

    const webhookPath =
      workspaces.size === 1
        ? "/hooks/linear"
        : `/hooks/linear/${wsName}`;

    api.registerHttpRoute({
      path: webhookPath,
      handler,
    });

    api.logger.info(
      `[linear:${wsName}] Webhook handler registered at ${webhookPath} (debounce: ${debounceMs}ms)`,
    );
  }
}

export async function deactivate(api: OpenClawPluginApi): Promise<void> {
  if (activeDebouncer) {
    for (const key of activeDebouncerKeys) {
      await activeDebouncer.flushKey(key);
    }
    activeDebouncerKeys.clear();
    activeDebouncer = undefined;
  }
  api.logger.info("Linear plugin deactivated");
}

const plugin = {
  id: "openclaw-linear",
  name: "Linear",
  description: "Linear project management integration for OpenClaw",
  activate,
  deactivate,
} satisfies {
  id: string;
  name: string;
  description: string;
  activate: (api: OpenClawPluginApi) => void;
  deactivate: (api: OpenClawPluginApi) => Promise<void>;
};

export default plugin;
