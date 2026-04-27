import { graphRunner } from "./langgraph/graph-factory";

export class AgentFactory {
  static async createGraphRunner() {
    await graphRunner.start();
    return graphRunner;
  }
}

