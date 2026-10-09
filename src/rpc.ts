import { Rpc } from "@opencode/plugin/rpc";

const status = {
  type: "object",
  properties: {
    proxies: { type: "array", items: { type: "string" } },
    providers: { type: "array", items: {
      type: "object", properties: { id: { type: "string" }, proxy: { type: "string" }, rotation: { type: "boolean" },
        consecutiveFailures: { type: "integer" }, failureThreshold: { type: "integer" }, exhausted: { type: "boolean" }, retryInMs: { type: "number" },
        pool: { type: "array", items: { type: "object", properties: { proxy: { type: "string" }, cooldownRemainingMs: { type: "number" } },
          required: ["proxy", "cooldownRemainingMs"], additionalProperties: false } },
      },
      required: ["id", "proxy", "rotation", "consecutiveFailures", "failureThreshold", "exhausted", "retryInMs", "pool"], additionalProperties: false,
    } },
  },
  required: ["proxies", "providers"], additionalProperties: false,
} as const;

export const CodeSocksRpc = Rpc.define({
  id: "codesocks",
  events: {},
  methods: {
    status: { input: { type: "object", additionalProperties: false }, output: status },
    reload: { input: { type: "object", additionalProperties: false }, output: status,
      errors: { reload_failed: { type: "object", additionalProperties: false } } },
    select: {
      input: { type: "object", properties: { providerID: { type: "string" }, proxy: { type: "string" }, persist: { type: "boolean" } },
        required: ["providerID", "proxy"], additionalProperties: false },
      output: status,
      errors: { invalid_selection: { type: "object", additionalProperties: false } },
    },
  },
});
