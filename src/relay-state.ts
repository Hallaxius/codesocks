import { createAgents, type EgressAgents } from "./agents.js";
import { Gate } from "./gate.js";
import { ProxyRotation } from "./rotation.js";
import type { CodeSocksConfig } from "./types.js";

/** A config generation owns its resources until its tickets/streams have drained. */
export class RelayState {
  readonly agents = new Map<string, EgressAgents>();
  readonly gates = new Map<string, Gate>();
  readonly rotations = new Map<string, ProxyRotation>();
  references = 0;
  retired = false;
  constructor(readonly config: CodeSocksConfig, sharedGates: Map<string, Gate>) {
    try {
      for (const route of Object.values(config.providers)) this.agent(route.proxy);
      for (const [id, route] of Object.entries(config.providers)) {
        const gate = sharedGates.get(id) ?? new Gate(route);
        gate.configure(route); sharedGates.set(id, gate);
        this.gates.set(id, gate); this.rotations.set(id, new ProxyRotation(route));
      }
    } catch { this.destroy(); throw Error("codesocks: invalid relay configuration"); }
  }
  agent(name: string): EgressAgents {
    let agent = this.agents.get(name);
    if (!agent) {
      const url = this.config.proxies[name];
      if (!url) throw Error("codesocks: unknown proxy");
      agent = createAgents(url); this.agents.set(name, agent);
    }
    return agent;
  }
  destroy(): void {
    for (const agent of this.agents.values()) agent.destroy();
    this.agents.clear(); this.gates.clear(); this.rotations.clear();
  }
}
