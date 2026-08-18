import type { EventSummary } from "../shared/contracts.js";

export interface LiveEvent {
  kind: "event" | "activity" | "snapshot_required" | "shutdown";
  event?: EventSummary;
  activity?: {
    agentId: string;
    goalId: string | null;
    sessionId: string;
    type: string;
    text: string;
    occurredAt: string;
  };
}

export class EventBroker {
  private readonly subscribers = new Set<(event: LiveEvent) => void>();

  subscribe(subscriber: (event: LiveEvent) => void): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  publish(event: LiveEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  publishPersisted(event: EventSummary): void {
    this.publish({ kind: "event", event });
  }

  requestSnapshot(): void {
    this.publish({ kind: "snapshot_required" });
  }

  shutdown(): void {
    this.publish({ kind: "shutdown" });
    this.subscribers.clear();
  }
}
