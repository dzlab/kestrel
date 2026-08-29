export class KestrelError extends Error {
  readonly code: string = "KESTREL_ERROR";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ValidationError extends KestrelError {
  readonly code = "VALIDATION_ERROR";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class PolicyError extends KestrelError {
  readonly code = "POLICY_ERROR";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class ApprovalRequiredError extends KestrelError {
  readonly code = "APPROVAL_REQUIRED";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class ToolExecutionError extends KestrelError {
  readonly code = "TOOL_EXECUTION_ERROR";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class PersistenceError extends KestrelError {
  readonly code = "PERSISTENCE_ERROR";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}
