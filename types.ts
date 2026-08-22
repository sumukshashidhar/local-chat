export type Message = {
  role: "user" | "assistant";
  content: string;
  /** Prior-turn thinking/reasoning to replay for models that require it (e.g. Kimi K3). */
  thinking?: string;
};
