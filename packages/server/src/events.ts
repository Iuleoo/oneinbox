import { EventEmitter } from 'node:events';
import type { AccountStatus } from '@inbox/shared';

export interface EventMap {
  'account:status': { accountId: number; status: AccountStatus; error?: string };
  'account:progress': { accountId: number; done: number; total: number };
  'message:new': { accountId: number; folderId: number; specialUse: string | null; count: number; ids: number[] };
  'message:flags': { accountId: number; ids: number[] };
  'message:removed': { accountId: number; ids: number[] };
  'message:op_failed': { messageId: number; op: string; error: string };
}

export type EventName = keyof EventMap;

class TypedEventBus {
  private readonly emitter = new EventEmitter({ captureRejections: false });

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit<K extends EventName>(name: K, payload: EventMap[K]): void {
    this.emitter.emit(name, payload);
  }

  on<K extends EventName>(name: K, listener: (payload: EventMap[K]) => void): () => void {
    this.emitter.on(name, listener);
    return () => this.emitter.off(name, listener);
  }

  /** Subscribe to every event (used by the SSE endpoint). */
  onAny(listener: (name: EventName, payload: EventMap[EventName]) => void): () => void {
    const names: EventName[] = [
      'account:status',
      'account:progress',
      'message:new',
      'message:flags',
      'message:removed',
      'message:op_failed',
    ];
    const handlers = names.map((n) => {
      const h = (payload: EventMap[EventName]) => listener(n, payload);
      this.emitter.on(n, h);
      return [n, h] as const;
    });
    return () => handlers.forEach(([n, h]) => this.emitter.off(n, h));
  }
}

export const events = new TypedEventBus();
