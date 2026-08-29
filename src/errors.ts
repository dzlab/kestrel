export class KestrelError extends Error {
  static readonly code: string = "KESTREL_ERROR";
  readonly code!: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    Object.defineProperty(this, "code", {
      value: (new.target as typeof KestrelError).code,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
}

export class ValidationError extends KestrelError {
  static readonly code = "VALIDATION_ERROR";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class PolicyError extends KestrelError {
  static readonly code = "POLICY_ERROR";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class ApprovalRequiredError extends KestrelError {
  static readonly code = "APPROVAL_REQUIRED";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class ToolExecutionError extends KestrelError {
  static readonly code = "TOOL_EXECUTION_ERROR";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class PersistenceError extends KestrelError {
  static readonly code = "PERSISTENCE_ERROR";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}
