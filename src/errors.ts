export class RpcError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = this.constructor.name;
  }
}

export class ValidationError extends RpcError {
  readonly issues: ReadonlyArray<{
    message: string;
    path?: ReadonlyArray<PropertyKey>;
  }>;

  constructor(
    issues: ReadonlyArray<{
      message: string;
      path?: ReadonlyArray<PropertyKey>;
    }>,
  ) {
    super(
      "VALIDATION_ERROR",
      `Validation failed: ${issues.map((i) => i.message).join(", ")}`,
    );
    this.issues = issues;
  }
}

export class EdgeNotFoundError extends RpcError {
  readonly edge: string;

  constructor(edge: string) {
    super("EDGE_NOT_FOUND", `Edge not found: ${edge}`);
    this.edge = edge;
  }
}

export class MethodNotFoundError extends RpcError {
  readonly method: string;

  constructor(method: string) {
    super("METHOD_NOT_FOUND", `Not found: ${method}`);
    this.method = method;
  }
}

export class ConnectionLostError extends RpcError {
  constructor() {
    super("CONNECTION_LOST", "All reconnection attempts failed");
  }
}
