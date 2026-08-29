import { expect, test } from "bun:test";
import {
  ApprovalRequiredError,
  KestrelError,
  PersistenceError,
  PolicyError,
  ToolExecutionError,
  ValidationError,
} from "../src/errors";

test("KestrelError always uses its stable base code", () => {
  expect(new KestrelError("x").code).toBe("KESTREL_ERROR");

  // @ts-expect-error KestrelError must not accept a custom error code.
  const attemptedCustomCode = new KestrelError("x", "CUSTOM_CODE");
  expect(attemptedCustomCode.code).toBe("KESTREL_ERROR");
});

test("error codes cannot be changed at runtime", () => {
  const errors = [
    [new KestrelError("x"), "KESTREL_ERROR"],
    [new ValidationError("x"), "VALIDATION_ERROR"],
    [new PolicyError("x"), "POLICY_ERROR"],
    [new ApprovalRequiredError("x"), "APPROVAL_REQUIRED"],
    [new ToolExecutionError("x"), "TOOL_EXECUTION_ERROR"],
    [new PersistenceError("x"), "PERSISTENCE_ERROR"],
  ] as const;

  for (const [error, code] of errors) {
    try {
      (error as { code: string }).code = "MUTATED";
    } catch {
      // Strict-mode assignment may throw for a non-writable property.
    }

    expect(error.code).toBe(code);
  }
});

test("new errors keep stable codes when constructor statics are mutated", () => {
  const constructors = [
    [KestrelError, "KESTREL_ERROR"],
    [ValidationError, "VALIDATION_ERROR"],
    [PolicyError, "POLICY_ERROR"],
    [ApprovalRequiredError, "APPROVAL_REQUIRED"],
    [ToolExecutionError, "TOOL_EXECUTION_ERROR"],
    [PersistenceError, "PERSISTENCE_ERROR"],
  ] as const;

  for (const [ErrorType, code] of constructors) {
    try {
      (ErrorType as { code: string }).code = "MUTATED";
    } catch {
      // A frozen static property may reject assignment in strict mode.
    }

    expect(new ErrorType("x").code).toBe(code);
  }
});
