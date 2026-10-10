import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuditEvent, PurchaseRequest, RequestStatus } from '../domain/types';
import { newId } from '../util/id';
import { DomainError } from '../util/errors';

export interface ListFilter {
  status?: RequestStatus[];
  departmentId?: string;
}

/**
 * Persistence boundary. The JSON implementation is enough for a hackathon;
 * swap in SQLite/Postgres by implementing this interface (no other file changes).
 */
export interface Store {
  insert(request: PurchaseRequest): void;
  update(id: string, mutate: (draft: PurchaseRequest) => void): PurchaseRequest;
  get(id: string): PurchaseRequest | undefined;
  /** Newest first. */
  list(filter?: ListFilter): PurchaseRequest[];
  appendAudit(event: Omit<AuditEvent, 'id'>): AuditEvent;
  /** Oldest first. */
  listAudit(requestId?: string): AuditEvent[];
}

interface Persisted {
  requests: Record<string, PurchaseRequest>;
  audit: AuditEvent[];
}

/** In-memory store that writes through to a JSON file atomically. Pass `null` for memory only (tests). */
export class JsonStore implements Store {
  private data: Persisted = { requests: {}, audit: [] };

  constructor(private readonly file: string | null) {
    if (file && existsSync(file)) {
      try {
        this.data = JSON.parse(readFileSync(file, 'utf8')) as Persisted;
      } catch {
        // Corrupt file: keep it for inspection and start clean instead of crashing the demo.
        renameSync(file, `${file}.corrupt-${Date.now()}`);
      }
    }
  }

  private persist(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }

  insert(request: PurchaseRequest): void {
    this.data.requests[request.id] = structuredClone(request);
    this.persist();
  }

  update(id: string, mutate: (draft: PurchaseRequest) => void): PurchaseRequest {
    const current = this.data.requests[id];
    if (!current) throw new DomainError('REQUEST_NOT_FOUND', `Solicitud ${id} no existe`, 404);
    const draft = structuredClone(current);
    mutate(draft);
    this.data.requests[id] = draft;
    this.persist();
    return structuredClone(draft);
  }

  get(id: string): PurchaseRequest | undefined {
    const r = this.data.requests[id];
    return r ? structuredClone(r) : undefined;
  }

  list(filter: ListFilter = {}): PurchaseRequest[] {
    return Object.values(this.data.requests)
      .filter((r) => (filter.status ? filter.status.includes(r.status) : true))
      .filter((r) => (filter.departmentId ? r.departmentId === filter.departmentId : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => structuredClone(r));
  }

  appendAudit(event: Omit<AuditEvent, 'id'>): AuditEvent {
    const full: AuditEvent = { id: newId('ev'), ...event };
    this.data.audit.push(full);
    this.persist();
    return structuredClone(full);
  }

  listAudit(requestId?: string): AuditEvent[] {
    const rows = requestId ? this.data.audit.filter((e) => e.requestId === requestId) : this.data.audit;
    return rows.map((e) => structuredClone(e));
  }
}
