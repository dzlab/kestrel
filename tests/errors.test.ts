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

test("instance error codes are non-writable and non-configurable", () => {
  const errors = [
    [new KestrelError("x"), "KESTREL_ERROR"],
    [new ValidationError("x"), "VALIDATION_ERROR"],
    [new PolicyError("x"), "POLICY_ERROR"],
    [new ApprovalRequiredError("x"), "APPROVAL_REQUIRED"],
    [new ToolExecutionError("x"), "TOOL_EXECUTION_ERROR"],
    [new PersistenceError("x"), "PERSISTENCE_ERROR"],
  ] as const;

  for (const [error, code] of errors) {
    expect(Object.getOwnPropertyDescriptor(error, "code")).toMatchObject({
      value: code,
      writable: false,
      configurable: false,
    });
    expect(Reflect.defineProperty(error, "code", { value: "MUTATED" })).toBe(false);
    expect(Reflect.deleteProperty(error, "code")).toBe(false);
    expect(error.code).toBe(code);
  }
});

test("static error codes are non-writable and non-configurable", () => {
  const constructors = [
    [KestrelError, "KESTREL_ERROR"],
    [ValidationError, "VALIDATION_ERROR"],
    [PolicyError, "POLICY_ERROR"],
    [ApprovalRequiredError, "APPROVAL_REQUIRED"],
    [ToolExecutionError, "TOOL_EXECUTION_ERROR"],
    [PersistenceError, "PERSISTENCE_ERROR"],
  ] as const;

  for (const [ErrorType, code] of constructors) {
    expect(Object.getOwnPropertyDescriptor(ErrorType, "code")).toMatchObject({
      value: code,
      writable: false,
      configurable: false,
    });
    expect(Reflect.defineProperty(ErrorType, "code", { value: "MUTATED" })).toBe(false);
    expect(Reflect.deleteProperty(ErrorType, "code")).toBe(false);
    expect(new ErrorType("x").code).toBe(code);
  }
});
