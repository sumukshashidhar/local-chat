// State
const state = {
  messages: [],
  isStreaming: false,
};

// DOM
const $ = (sel) => document.querySelector(sel);
const modelSelect = $("#model-select");
const systemToggle = $("#system-toggle");
const systemPanel = $("#system-panel");
const systemPrompt = $("#system-prompt");
const messagesEl = $("#messages");
const chatForm = $("#chat-form");
const input = $("#input");
const sendBtn = $("#send-btn");

// Toggle system panel
systemToggle.addEventListener("click", () => {
  systemPanel.classList.toggle("hidden");
  systemToggle.classList.toggle("active");
});

// Auto-resize input
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 200) + "px";
});

// Handle form submit
chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || state.isStreaming) return;

  // Add user message
  addMessage("user", text);
  input.value = "";
  input.style.height = "auto";

  // Start streaming
  await streamResponse();
});

// Keyboard shortcut: Enter to send, Shift+Enter for newline
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    chatForm.dispatchEvent(new Event("submit"));
  }
});

function addMessage(role, content) {
  state.messages.push({ role, content });
  renderMessage(role, content);
}

function renderMessage(role, content, isStreaming = false) {
  const div = document.createElement("div");
  div.className = `message ${role}`;
  if (isStreaming) div.classList.add("loading");
  div.innerHTML = formatContent(content);
  messagesEl.appendChild(div);
  scrollToBottom();
  return div;
}

function formatContent(text) {
  // Simple markdown: code blocks, inline code, paragraphs
  return text
    .replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .split('\n\n')
    .map(p => p.trim() ? `<p>${p}</p>` : '')
    .join('');
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function streamResponse() {
  state.isStreaming = true;
  sendBtn.disabled = true;

  // Create assistant message element
  const assistantDiv = renderMessage("assistant", "", true);
  let fullContent = "";

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelSelect.value,
        system: systemPrompt.value,
        messages: state.messages,
      }),
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split("\n");

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;

        try {
          const data = JSON.parse(line.slice(6));

          if (data.type === "delta") {
            fullContent += data.text;
            assistantDiv.innerHTML = formatContent(fullContent);
            scrollToBottom();
          } else if (data.type === "done") {
            // Cache info in usage
            if (data.usage?.cache_read_input_tokens) {
              console.log("Cache hit:", data.usage.cache_read_input_tokens, "tokens");
            }
          } else if (data.type === "error") {
            fullContent = `Error: ${data.error}`;
            assistantDiv.innerHTML = formatContent(fullContent);
          }
        } catch {
          // Skip malformed JSON
        }
      }
    }

    // Save to state
    state.messages.push({ role: "assistant", content: fullContent });

  } catch (error) {
    assistantDiv.innerHTML = formatContent(`Error: ${error.message}`);
  } finally {
    assistantDiv.classList.remove("loading");
    state.isStreaming = false;
    sendBtn.disabled = false;
    input.focus();
  }
}
