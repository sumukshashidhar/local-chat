import type { Message } from "./types";

/** Prompt caching TTL sent to OpenRouter for system prompt + latest turn. */
export const PROMPT_CACHE_TTL = "1h" as const;

/**
 * Build the OpenRouter `messages` payload.
 *
 * Moonshot (and some other providers) reject `{ type: "text", text: "" }` with
 * "text content is empty". The client appends an empty assistant node as a
 * streaming placeholder; strip trailing empty stubs. For mid-history assistant
 * turns that only have thinking (interrupted stream), use a non-empty content
 * placeholder so reasoning can still be replayed.
 */
export function buildOpenRouterMessages(
  system: string,
  messages: Message[],
): Array<Record<string, unknown>> {
  const openRouterMessages: Array<Record<string, unknown>> = [];

  if (system) {
    openRouterMessages.push({
      role: "system",
      content: [
        {
          type: "text",
          text: system,
          cache_control: { type: "ephemeral", ttl: PROMPT_CACHE_TTL },
        },
      ],
    });
  }

  // Drop trailing empty assistant placeholders (no content, no thinking).
  let msgs = messages;
  while (msgs.length > 0) {
    const last = msgs[msgs.length - 1];
    if (
      last.role === "assistant" &&
      !last.content.trim() &&
      !last.thinking
    ) {
      msgs = msgs.slice(0, -1);
      continue;
    }
    break;
  }

  // Cache breakpoint: last user turn before generation, or the user before an
  // assistant prefill (continue mode).
  const cacheAt =
    msgs.length === 0
      ? -1
      : msgs[msgs.length - 1].role === "assistant"
        ? msgs.length - 2
        : msgs.length - 1;

  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i];
    // Providers reject empty text parts. Keep a single space when content is
    // blank (e.g. interrupted assistant turn that only has thinking).
    const text = msg.content.trim().length > 0 ? msg.content : " ";

    const openRouterMsg: Record<string, unknown> = {
      role: msg.role,
      content: [
        {
          type: "text",
          text,
          ...(i === cacheAt && {
            cache_control: { type: "ephemeral", ttl: PROMPT_CACHE_TTL },
          }),
        },
      ],
    };

    // Replay prior-turn reasoning for models that require preserved thinking
    // (Moonshot Kimi K3 / OpenRouter reasoning_details continuity).
    if (msg.role === "assistant" && msg.thinking) {
      openRouterMsg.reasoning = msg.thinking;
      openRouterMsg.reasoning_content = msg.thinking;
    }
    openRouterMessages.push(openRouterMsg);
  }

  return openRouterMessages;
}
