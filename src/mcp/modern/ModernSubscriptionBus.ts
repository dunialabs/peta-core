import { EventEmitter } from 'events';
import type { JsonObject } from './ModernMcpTypes.js';

export interface ModernSubscriptionEvent {
  method: string;
  serverId?: string;
  scopeId?: string;
  resourceUri?: string;
  params: JsonObject;
}

class ModernSubscriptionBus extends EventEmitter {
  publish(event: ModernSubscriptionEvent): void {
    this.emit('event', event);
  }

  onEvent(listener: (event: ModernSubscriptionEvent) => void): void {
    this.on('event', listener);
  }

  offEvent(listener: (event: ModernSubscriptionEvent) => void): void {
    this.off('event', listener);
  }
}

export const modernSubscriptionBus = new ModernSubscriptionBus();
