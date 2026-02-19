/**
 * Wire message types for client ↔ server communication.
 */

// -- Node schema --

export interface NodeSchema {
  edges: Record<string, number>; // edge name → target type index
}

export type Schema = NodeSchema[]; // index 0 = root type

// -- Client → Server messages --

export interface EdgeMessage {
  op: "edge";
  tok: number; // token identifying the parent node
  edge: string;
  args?: unknown[];
}

export interface GetMessage {
  op: "get";
  tok: number; // token identifying the target node
  name: string;
  args?: unknown[];
}

export interface DataMessage {
  op: "data";
  tok: number; // token identifying the target node
}

export type ClientMessage = EdgeMessage | GetMessage | DataMessage;

// -- Server → Client messages --
//
// Each result type is a discriminated union: a response carries either
// a success payload or an error, never both.  The `error` field is only
// present when the server-side handler *threw*; a returned value (even
// an Error instance) lands in `data` and resolves on the client.

export interface EdgeSuccess {
  op: "edge";
  tok: number; // newly assigned token for the child node
  re: number; // sequence number of the client message being answered
}

export interface EdgeFailure {
  op: "edge";
  tok: number; // newly assigned token (poisoned on failure)
  re: number; // sequence number of the client message being answered
  error: unknown;
  errorId?: string;
}

export type EdgeResult = EdgeSuccess | EdgeFailure;

export interface GetSuccess {
  op: "get";
  tok: number;
  re: number; // sequence number of the client message being answered
  data: unknown;
}

export interface GetFailure {
  op: "get";
  tok: number;
  re: number; // sequence number of the client message being answered
  error: unknown;
  errorId?: string;
}

export type GetResult = GetSuccess | GetFailure;

export interface DataSuccess {
  op: "data";
  tok: number;
  re: number; // sequence number of the client message being answered
  data: unknown;
}

export interface DataFailure {
  op: "data";
  tok: number;
  re: number; // sequence number of the client message being answered
  error: unknown;
  errorId?: string;
}

export type DataResult = DataSuccess | DataFailure;

export interface HelloMessage {
  op: "hello";
  version: number;
  schema: Schema;
}

export type ServerMessage = EdgeResult | GetResult | DataResult | HelloMessage;

// -- Message validation --

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function hasExactKeys(
  obj: Record<string, unknown>,
  required: string[],
  optional: string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) return false;
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) return false;
  }
  return true;
}

export function parseClientMessage(value: unknown): ClientMessage {
  if (!isPlainObject(value)) {
    throw new Error(
      `Expected object, got ${value === null ? "null" : typeof value}`,
    );
  }

  switch (value.op) {
    case "edge": {
      const required = ["op", "tok", "edge"];
      const optional = ["args"];
      if (!hasExactKeys(value, required, optional)) {
        throw new Error(
          `Invalid "edge" message keys: ${JSON.stringify(Object.keys(value))}`,
        );
      }
      if (!isNonNegativeInt(value.tok)) {
        throw new Error(
          `"edge" message "tok" must be a non-negative integer, got ${JSON.stringify(value.tok)}`,
        );
      }
      if (typeof value.edge !== "string") {
        throw new Error(
          `"edge" message "edge" must be a string, got ${typeof value.edge}`,
        );
      }
      if ("args" in value && !Array.isArray(value.args)) {
        throw new Error(
          `"edge" message "args" must be an array, got ${typeof value.args}`,
        );
      }
      return value as unknown as EdgeMessage;
    }

    case "get": {
      const required = ["op", "tok", "name"];
      const optional = ["args"];
      if (!hasExactKeys(value, required, optional)) {
        throw new Error(
          `Invalid "get" message keys: ${JSON.stringify(Object.keys(value))}`,
        );
      }
      if (!isNonNegativeInt(value.tok)) {
        throw new Error(
          `"get" message "tok" must be a non-negative integer, got ${JSON.stringify(value.tok)}`,
        );
      }
      if (typeof value.name !== "string") {
        throw new Error(
          `"get" message "name" must be a string, got ${typeof value.name}`,
        );
      }
      if ("args" in value && !Array.isArray(value.args)) {
        throw new Error(
          `"get" message "args" must be an array, got ${typeof value.args}`,
        );
      }
      return value as unknown as GetMessage;
    }

    case "data": {
      const required = ["op", "tok"];
      if (!hasExactKeys(value, required, [])) {
        throw new Error(
          `Invalid "data" message keys: ${JSON.stringify(Object.keys(value))}`,
        );
      }
      if (!isNonNegativeInt(value.tok)) {
        throw new Error(
          `"data" message "tok" must be a non-negative integer, got ${JSON.stringify(value.tok)}`,
        );
      }
      return value as unknown as DataMessage;
    }

    default:
      throw new Error(`Unknown client message op: ${JSON.stringify(value.op)}`);
  }
}

/**
 * Light validation of server messages. We trust the server to behave, so
 * this only checks the `op` discriminator — not individual fields.
 * Full field-by-field validation lives in parseClientMessage where
 * untrusted input matters.
 */
export function parseServerMessage(value: unknown): ServerMessage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `Expected object, got ${value === null ? "null" : typeof value}`,
    );
  }
  const msg = value as Record<string, unknown>;
  switch (msg.op) {
    case "hello":
    case "edge":
    case "get":
    case "data":
      return msg as unknown as ServerMessage;
    default:
      throw new Error(`Unknown server message op: ${JSON.stringify(msg.op)}`);
  }
}

// -- Transport interface --

export interface TransportEventMap {
  message: { readonly data: string };
  close: {};
  error: {};
}

export interface Transport {
  send(data: string): void;
  close(): void;
  addEventListener<K extends keyof TransportEventMap>(
    type: K,
    listener: (event: TransportEventMap[K]) => void,
  ): void;
  removeEventListener<K extends keyof TransportEventMap>(
    type: K,
    listener: (event: TransportEventMap[K]) => void,
  ): void;
}

/** Convert event.data (which may be a string, Buffer, or ArrayBuffer) to a string. */
export function eventDataToString(data: unknown): string {
  return typeof data === "string"
    ? data
    : new TextDecoder().decode(data as any);
}

/** Test-only mock transport pair. Messages are delivered asynchronously via queueMicrotask. Buffers messages sent before any 'message' listener is registered. close() fires 'close' listeners synchronously on both sides. */
export function createMockTransportPair(): [Transport, Transport] {
  type Listener<K extends keyof TransportEventMap> = (
    event: TransportEventMap[K],
  ) => void;
  type ListenerSets = { [K in keyof TransportEventMap]: Set<Listener<K>> };

  const listeners: [ListenerSets, ListenerSets] = [
    { message: new Set(), close: new Set(), error: new Set() },
    { message: new Set(), close: new Set(), error: new Set() },
  ];
  const buffers: [string[], string[]] = [[], []];
  let closed = false;

  const create = (side: 0 | 1): Transport => {
    const transport: Transport = {
      send(data: string) {
        if (closed) return;
        const other = side === 0 ? 1 : 0;
        queueMicrotask(() => {
          if (closed) return;
          const set = listeners[other].message;
          if (set.size > 0) {
            const event = { data };
            for (const listener of set) listener(event);
          } else {
            buffers[other].push(data);
          }
        });
      },
      close() {
        if (closed) return;
        closed = true;
        for (const s of [0, 1] as const) {
          for (const listener of listeners[s].close) listener({});
        }
      },
      addEventListener(type: string, listener: any) {
        (listeners[side] as any)[type].add(listener);
        // Flush buffered messages on first 'message' listener
        if (type === "message" && buffers[side].length > 0) {
          const msgs = buffers[side].splice(0);
          for (const msg of msgs) {
            queueMicrotask(() => listener({ data: msg }));
          }
        }
      },
      removeEventListener(type: string, listener: any) {
        (listeners[side] as any)[type].delete(listener);
      },
    };
    return transport;
  };

  return [create(0), create(1)];
}
