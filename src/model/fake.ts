import type { ModelClient } from "./client";
import type { ModelRequest, ModelResponse } from "../protocol/types";

export class FakeModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  private readonly scriptedResponses: ModelResponse[];

  constructor(responses: readonly ModelResponse[]) {
    this.scriptedResponses = [...responses];
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const response = this.scriptedResponses.shift();
    if (response === undefined) {
      throw new Error("fake model script exhausted");
    }

    return response;
  }

  remaining(): number {
    return this.scriptedResponses.length;
  }
}
