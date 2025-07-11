#!/usr/bin/env node
/**
 * ChatGPT MCP server – bruisedsamurai fork, updated to register the tool and stay alive.
 * Runs on stdio so Model Context Protocol clients (e.g., .NET SDK) can connect.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { runAppleScript } from "run-applescript";
import { run } from "@jxa/run";
import { spawn, spawnSync } from "child_process";

/* -------------------------------------------------------------------------- */
/*                               Helper utilities                             */
/* -------------------------------------------------------------------------- */

/** Escape a string for AppleScript literals. */
const encodeForAppleScript = (text: string): string =>
  text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/**
 * Cross-platform clipboard setter.
 *   • macOS   – pbcopy  
 *   • Linux   – xclip (X11/Wayland)  
 *   • Windows – PowerShell Set-Clipboard  
 *   • Fallback – AppleScript
 */
function setClipboard(text: string) {
  if (process.platform === "darwin") {
    const proc = spawn("pbcopy", [], {
      env: { ...process.env, LC_CTYPE: "UTF-8" },
    });
    proc.stdin.write(text);
    proc.stdin.end();
  } else if (process.platform === "linux") {
    spawnSync("xclip", ["-selection", "clipboard"], { input: text });
  } else if (process.platform === "win32") {
    spawnSync("powershell.exe", [
      "-NoLogo",
      "-Command",
      `Set-Clipboard -Value @'\n${text}\n'@`,
    ]);
  } else {
    spawnSync("osascript", [
      "-e",
      `set the clipboard to "${encodeForAppleScript(text)}"`,
    ]);
  }
}

/** Cross-platform clipboard getter. */
function getClipboard(): string {
  if (process.platform === "darwin") {
    return spawnSync("pbpaste", { encoding: "utf8" }).stdout;
  } else if (process.platform === "linux") {
    return spawnSync("xclip", ["-selection", "clipboard", "-o"], {
      encoding: "utf8",
    }).stdout;
  } else if (process.platform === "win32") {
    return spawnSync(
      "powershell.exe",
      ["-NoLogo", "-Command", "Get-Clipboard"],
      { encoding: "utf8" },
    ).stdout;
  }
  return runAppleScript("the clipboard");
}

/* -------------------------------------------------------------------------- */
/*                                 Tool model                                 */
/* -------------------------------------------------------------------------- */

const CHATGPT_TOOL: Tool = {
  name: "chatgpt",
  description: "Interact with the ChatGPT desktop app on macOS",
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        description: "Operation: 'ask' or 'get_conversations'",
        enum: ["ask", "get_conversations"],
      },
      prompt: {
        type: "string",
        description: "Prompt text (required for 'ask')",
      },
      conversation_id: {
        type: "string",
        description: "Optional existing conversation ID",
      },
    },
    required: ["operation"],
  },
};

/* -------------------------------------------------------------------------- */
/*                               MCP server init                              */
/* -------------------------------------------------------------------------- */

const server = new Server(
  { name: "ChatGPT MCP Tool", version: "1.0.0" },
  {
    capabilities: {
      tools: { chatgpt: CHATGPT_TOOL }, // Expose the tool to clients
    },
  },
);

/* -------------------------------------------------------------------------- */
/*                           ChatGPT interaction logic                        */
/* -------------------------------------------------------------------------- */

async function ensureChatGPTRunning(): Promise<void> {
  const isRunning = await runAppleScript(`
    tell application "System Events"
      return application process "ChatGPT" exists
    end tell`);
  if (isRunning !== "true") {
    console.log("ChatGPT not running—launching…");
    await runAppleScript(`tell application "ChatGPT" to activate`);
  }
}

async function askChatGPT(prompt: string, conversationId?: string) {
  await ensureChatGPTRunning();

  // 1. Save your existing clipboard so we can restore it later
  const originalClipboard = getClipboard();
  // 2. Put our prompt on the clipboard so we can “paste” it into the ChatGPT window
  setClipboard(prompt);

  // 3. Send keystrokes to paste the prompt, send it, wait for generation, then copy the response
  await runAppleScript(`
    tell application "ChatGPT" to activate
    delay 1
    tell application "System Events"
      tell process "ChatGPT"
        ${conversationId 
          ? `click button "${conversationId}" of group 1 of group 1 of window 1`
          : ""
        }
        delay 0.4
        -- clear the input area
        keystroke "a" using {command down}
        keystroke (ASCII character 8)
        -- paste our prompt
        keystroke "v" using {command down}
        delay 0.4
        -- send it
        keystroke return

        -- wait until ChatGPT finishes generating (Stop generating button goes away)
        repeat while exists button "Stop generating" of window 1
          delay 0.5
        end repeat
        delay 0.2

        -- select all response text and copy
        keystroke "a" using {command down}
        keystroke "c" using {command down}
      end tell
    end tell
  `);

  // 4. Give macOS a moment to update the clipboard
  await new Promise(r => setTimeout(r, 100));

  // 5. Grab the freshly-copied response
  const response = getClipboard();

  // 6. Restore the user’s original clipboard contents
  setClipboard(originalClipboard);

  return response;
}

async function getConversations(): Promise<string[]> {
  await ensureChatGPTRunning();
  const result = await runAppleScript(`
    tell application "ChatGPT"
      activate
      delay 1
      tell application "System Events"
        tell process "ChatGPT"
          set c to buttons of group 1 of group 1 of window 1
          set titles to {}
          repeat with b in c
            if name of b is not "New chat" then set end of titles to name of b
          end repeat
          return titles
        end tell
      end tell
    end tell`);
  return Array.isArray(result) ? result : [];
}

/* -------------------------------------------------------------------------- */
/*                    MCP request / response handlers                         */
/* -------------------------------------------------------------------------- */

function isChatGPTArgs(args: unknown): args is {
  operation: "ask" | "get_conversations";
  prompt?: string;
  conversation_id?: string;
} {
  if (typeof args !== "object" || args === null) return false;
  const { operation, prompt, conversation_id } = args as any;
  if (!["ask", "get_conversations"].includes(operation)) return false;
  if (operation === "ask" && !prompt) return false;
  if (prompt && typeof prompt !== "string") return false;
  if (conversation_id && typeof conversation_id !== "string") return false;
  return true;
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [CHATGPT_TOOL],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name !== "chatgpt") {
    return { content: [{ type: "text", text: "Unknown tool" }], isError: true };
  }
  if (!isChatGPTArgs(args)) {
    return { content: [{ type: "text", text: "Invalid arguments" }], isError: true };
  }

  try {
    if (args.operation === "ask") {
      const text = await askChatGPT(args.prompt!, args.conversation_id);
      return { content: [{ type: "text", text }], isError: false };
    } else {
      const list = await getConversations();
      const text = list.length ? list.join("\n") : "No conversations found.";
      return { content: [{ type: "text", text }], isError: false };
    }
  } catch (err) {
    return {
      content: [
        { type: "text", text: `Error: ${err instanceof Error ? err.message : err}` },
      ],
      isError: true,
    };
  }
});

/* -------------------------------------------------------------------------- */
/*                            Start stdio transport                           */
/* -------------------------------------------------------------------------- */

console.error("ChatGPT MCP Server starting on stdio…");
const transport = new StdioServerTransport();

try {
  await server.connect(transport); // blocks until stdin closes
  console.error("ChatGPT MCP Server stopped (stdin closed)");
} catch (err) {
  console.error("Fatal MCP server error:", err);
  process.exit(1);
}
