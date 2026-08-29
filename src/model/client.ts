import type { ModelRequest, ModelResponse } from "../protocol/types";

export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResponse>;
}
