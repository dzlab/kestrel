export class KestrelError extends Error {
  readonly code: string;

  constructor(message: string, code = "KESTREL_ERROR", options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class ValidationError extends KestrelError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "VALIDATION_ERROR", options);
  }
}

export class PolicyError extends KestrelError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "POLICY_ERROR", options);
  }
}

export class ApprovalRequiredError extends KestrelError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "APPROVAL_REQUIRED", options);
  }
}

export class ToolExecutionError extends KestrelError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "TOOL_EXECUTION_ERROR", options);
  }
}

export class PersistenceError extends KestrelError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "PERSISTENCE_ERROR", options);
  }
}
