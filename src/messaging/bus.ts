import { EventEmitter } from "node:events";
import type { A2AMessageType } from "../types/entities";
import type { A2AMessageEnvelope } from "../types/a2a";

type BusEventMap = {
  [K in A2AMessageType]: [A2AMessageEnvelope];
} & {
  "*": [A2AMessageEnvelope];
  error: [Error];
};

/**
 * In-memory event bus for A2A messages.
 *
 * All agents publish and subscribe through this bus.
 * In V1 this is a single-process EventEmitter; in V2 it can be replaced
 * by a distributed transport (NATS, Redis Streams) without changing the API.
 */
class MessageBus extends EventEmitter {
  private static _instance: MessageBus | null = null;

  private constructor() {
    super();
    this.setMaxListeners(100);
  }

  static getInstance(): MessageBus {
    if (!MessageBus._instance) {
      MessageBus._instance = new MessageBus();
    }
    return MessageBus._instance;
  }

  /**
   * Publish an A2A message to all registered handlers.
   */
  publish(message: A2AMessageEnvelope): void {
    this.emit(message.messageType, message);
    this.emit("*", message);
  }

  /**
   * Subscribe to a specific message type.
   */
  subscribe(
    type: A2AMessageType | "*",
    handler: (message: A2AMessageEnvelope) => void | Promise<void>
  ): () => void {
    const wrappedHandler = async (msg: A2AMessageEnvelope) => {
      try {
        await handler(msg);
      } catch (err) {
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      }
    };
    this.on(type, wrappedHandler);
    return () => this.off(type, wrappedHandler);
  }

  /**
   * Subscribe to a message type and auto-unsubscribe after the first match.
   */
  once_typed(
    type: A2AMessageType,
    handler: (message: A2AMessageEnvelope) => void | Promise<void>
  ): void {
    this.once(type, handler);
  }

  reset(): void {
    this.removeAllListeners();
  }
}

export const messageBus = MessageBus.getInstance();
